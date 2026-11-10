//! Miscellaneous endpoint handlers: telemetry, i18n, questionnaire, image-proxy,
//! link-preview, and MCP bridge.
//!
//! Groups several small, unrelated REST endpoints:
//! - `POST /api/telemetry` — client-side event telemetry ingestion
//! - `GET /api/i18n/{locale}` — i18n bundle delivery
//! - `POST /api/questionnaire` — user questionnaire submission
//! - `GET /api/proxy/image` — image proxy (rewrites opaque image URLs)
//! - `GET /api/proxy/link` — link-preview metadata fetch
//! - `/mcp` — Model Context Protocol JSON-RPC bridge (SSE + HTTP)

use axum::{
  extract::{Json as ExtractJson, Path, Query, State},
  http::{HeaderMap, StatusCode},
  response::{IntoResponse, Json},
};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tracing::{debug, instrument, warn};
use uuid::Uuid;

use crate::handlers::health::MYOXUS_SERVER_VERSION;
use crate::state::ApiState;

pub(crate) const SUPPORTED_I18N_LOCALES: &[&str] = &[
  "en", "ar", "ca", "da", "de", "es", "es-AR", "es-CL", "fa", "fr", "hi", "it", "ja", "ko", "nb-NO", "pl", "pt-BR",
  "ru", "sv-SE", "uk", "ur", "zh-Hans", "zh-Hant",
];

/// Acknowledgment body returned after telemetry ingestion.
#[derive(Debug, Serialize)]
pub(crate) struct TelemetryAck {
  ok: bool,
  /// Number of events that were successfully recorded.
  accepted: usize,
  /// Number of events that were dropped (e.g. category-disabled, sampled,
  /// duplicate).
  dropped: usize,
}

/// A single selectable option in a questionnaire question.
#[derive(Debug, Serialize)]
pub(crate) struct QuestionnaireOption {
  #[serde(rename = "type")]
  option_type: &'static str,
  label: &'static str,
  value: &'static str,
}

/// A single questionnaire question with its list of selectable options.
#[derive(Debug, Serialize)]
pub(crate) struct QuestionnaireQuestion {
  id: &'static str,
  question: &'static str,
  options: Vec<QuestionnaireOption>,
}

/// Submitted answer to a questionnaire question.
#[derive(Debug, Deserialize)]
pub(crate) struct QuestionnaireAnswer {
  /// Questionnaire form identifier.
  form: String,
  /// Question ID being answered.
  ask: String,
  /// Selected option values.
  answer: Vec<String>,
}

/// Request body for `POST /api/worker/link-preview`.
#[derive(Debug, Deserialize)]
pub(crate) struct LinkPreviewRequest {
  /// URL to fetch link-preview metadata for.
  url: String,
  /// When `true`, use a HEAD request to avoid downloading the full body.
  head: Option<bool>,
}

/// Response body for link-preview metadata.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LinkPreviewResponse {
  /// Canonical URL of the resource.
  url: String,
  /// Page title (`<title>` or `og:title`).
  title: Option<String>,
  /// Site name (`og:site_name`).
  site_name: Option<String>,
  /// Page description.
  description: Option<String>,
  /// List of image URLs found in the page's Open Graph tags.
  images: Vec<String>,
  /// Media type reported by the server (e.g. `"website"`, `"article"`).
  media_type: Option<String>,
  /// HTTP `Content-Type` header value.
  content_type: Option<String>,
  /// Character set declared by the response.
  charset: Option<String>,
  /// Video URLs found in Open Graph tags.
  videos: Vec<String>,
  /// Favicon URLs found on the page.
  favicons: Vec<String>,
}

/// Query parameters for `GET /api/worker/image-proxy`.
#[derive(Debug, Deserialize)]
pub(crate) struct WorkerImageProxyQuery {
  /// URL of the image to proxy.
  url: String,
}

/// Response body for `GET /api/i18n/config`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct I18nConfigResponse {
  /// BCP-47 locale code used as the server default.
  default_locale: String,
  /// List of all BCP-47 locale codes available on this server.
  available_locales: Vec<String>,
}

/// Request body for `PUT /api/i18n/config` (admin only).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct I18nConfigUpdateRequest {
  /// New server default locale.
  default_locale: Option<String>,
  /// Updated list of available locales.
  available_locales: Option<Vec<String>>,
}

/// Minimal JSON-RPC 2.0 request envelope parsed at the workspace-scoped MCP bridge.
#[derive(Debug, Deserialize)]
pub(crate) struct McpRequest {
  jsonrpc: Option<String>,
  method: Option<String>,
  id: Option<serde_json::Value>,
}

/// JSON-RPC 2.0 error object included in error responses.
#[derive(Debug, Serialize)]
pub(crate) struct McpErrorObject {
  /// JSON-RPC error code (e.g. `-32601` for method-not-found).
  code: i32,
  /// Human-readable error message.
  message: String,
}

/// JSON-RPC 2.0 response envelope returned by the workspace-scoped MCP bridge.
#[derive(Debug, Serialize)]
pub(crate) struct McpResponse {
  jsonrpc: &'static str,
  #[serde(skip_serializing_if = "Option::is_none")]
  result: Option<serde_json::Value>,
  #[serde(skip_serializing_if = "Option::is_none")]
  error: Option<McpErrorObject>,
  #[serde(skip_serializing_if = "Option::is_none")]
  id: Option<serde_json::Value>,
}

/// `POST /api/telemetry/collect` — ingest a batch of client-side analytics events.
///
/// Events run through [`TelemetryIngestService::ingest_batch`]: category
/// filter, sampling, dedupe (Redis SETNX), PII scrub, then push to the hot
/// buffer for later flush by the worker job.  When telemetry is globally
/// disabled returns 503; otherwise 200 with an accept/drop summary. The
/// router throttle enforces the configured per-IP request budget before ingest
/// and returns 429 with Retry-After when it is exhausted.
#[instrument(skip_all)]
pub(crate) async fn telemetry_collect_handler(
  State(state): State<ApiState>,
  ExtractJson(batch): ExtractJson<myoxus_application::telemetry::TelemetryBatch>,
) -> impl IntoResponse {
  let policy = state.telemetry_policy();
  // INV-TEL-03: telemetry globally disabled → 503, do not enqueue.
  if !policy.enabled {
    return (
      StatusCode::SERVICE_UNAVAILABLE,
      Json(TelemetryAck {
        ok: false,
        accepted: 0,
        dropped: batch.events.as_ref().map(Vec::len).unwrap_or(0),
      }),
    )
      .into_response();
  }
  let events = batch.events.unwrap_or_default();
  let (accepted, dropped) = state.telemetry().ingest_batch(events, &policy).await;
  let ack = TelemetryAck {
    ok: true,
    accepted,
    dropped,
  };
  (StatusCode::OK, Json(ack)).into_response()
}

/// `GET /api/telemetry/status` — policy snapshot for the client (P-Telemetry-F).
///
/// Unauthenticated; returns the public flags the client needs to implement
/// client-side opt-out and pre-sampling so we don't waste bandwidth on events
/// the server would drop anyway.
///
/// Shape:
/// ```json
/// {
///   "enabled": true,
///   "categories": { "page_view": true, "doc_op": true, "error": true, … },
///   "samplingRates": { "page_view": 1.0, "doc_op": 0.5, … },
///   "schema": { "min": 1, "max": 1 }
/// }
/// ```
///
/// When `enabled=false`, the client MUST NOT send events — the collect
/// endpoint returns 503 in that state anyway.  Even when enabled the client
/// is free to drop events locally based on `samplingRates` to save bandwidth.
#[instrument(skip_all)]
pub(crate) async fn telemetry_status_handler(State(state): State<ApiState>) -> impl IntoResponse {
  let policy = state.telemetry_policy();
  let body = serde_json::json!({
    "enabled": policy.enabled,
    "categories": policy.categories,
    "samplingRates": policy.sampling_rates,
    "schema": {
      "min": myoxus_application::telemetry::TELEMETRY_SCHEMA_MIN,
      "max": myoxus_application::telemetry::TELEMETRY_SCHEMA_MAX,
    },
  });
  (StatusCode::OK, Json(body))
}

/// `GET /api/worker/questionnaire` — return available questionnaire questions.
///
/// Currently returns an empty list (questionnaire feature is a stub).
#[instrument(skip_all)]
pub(crate) async fn worker_questionnaire_get_handler() -> impl IntoResponse {
  let questions: Vec<QuestionnaireQuestion> = Vec::new();
  (StatusCode::OK, Json(questions))
}

/// `POST /api/worker/questionnaire` — accept a questionnaire answer submission.
///
/// Logs the submission at `debug` level and returns 204 No Content.
#[instrument(skip_all)]
pub(crate) async fn worker_questionnaire_post_handler(
  ExtractJson(answer): ExtractJson<QuestionnaireAnswer>,
) -> impl IntoResponse {
  debug!(
      form = %answer.form,
      ask = %answer.ask,
      answers = answer.answer.len(),
      "questionnaire response accepted"
  );
  StatusCode::NO_CONTENT
}

/// `GET /api/i18n/config` — return the server's i18n configuration (default locale and available locales).
#[instrument(skip_all)]
pub(crate) async fn i18n_config_get_handler(State(state): State<ApiState>) -> Result<impl IntoResponse, StatusCode> {
  let config = effective_i18n_config(&state).await?;
  Ok((StatusCode::OK, Json(config)))
}

/// `PUT /api/i18n/config` — update the server's i18n configuration (admin only).
///
/// Persists the update through the canonical PostgreSQL configuration writer
/// and publishes the existing Redis invalidation for other instances.
/// Requires an admin session.
#[instrument(skip_all)]
pub(crate) async fn i18n_config_put_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Json(body): Json<I18nConfigUpdateRequest>,
) -> Result<impl IntoResponse, StatusCode> {
  let admin_user_id = crate::require_admin_user(&state, &headers).await?;
  let mut effective = effective_i18n_config(&state).await?;

  if let Some(locales) = body.available_locales {
    let mut normalized = normalize_locales(locales);
    if normalized.is_empty() {
      return Err(StatusCode::BAD_REQUEST);
    }
    if normalized.iter().any(|locale| !is_supported_locale(locale)) {
      return Err(StatusCode::BAD_REQUEST);
    }
    if !normalized.contains(&effective.default_locale) {
      effective.default_locale = normalized.first().cloned().unwrap_or_else(|| "en".to_string());
    }
    effective.available_locales.clear();
    effective.available_locales.append(&mut normalized);
  }

  if let Some(default_locale) = body.default_locale {
    let default_locale = default_locale.trim().to_string();
    if default_locale.is_empty() {
      return Err(StatusCode::BAD_REQUEST);
    }
    if !is_supported_locale(&default_locale) {
      return Err(StatusCode::BAD_REQUEST);
    }
    effective.default_locale = default_locale;
    if !effective.available_locales.contains(&effective.default_locale) {
      effective.available_locales.insert(0, effective.default_locale.clone());
      effective.available_locales = normalize_locales(effective.available_locales);
    }
  }

  let Some(pool) = state.metrics_pool() else {
    return Ok((StatusCode::OK, Json(effective)));
  };

  let updates = vec![
    (
      "i18n.default_locale".to_string(),
      serde_json::Value::String(effective.default_locale.clone()),
    ),
    (
      "i18n.available_locales".to_string(),
      serde_json::Value::Array(
        effective
          .available_locales
          .iter()
          .cloned()
          .map(serde_json::Value::String)
          .collect(),
      ),
    ),
  ];

  let mutations = updates
    .into_iter()
    .map(|(path, value)| myoxus_infrastructure::app_config::ConfigMutation::Set { path, value })
    .collect::<Vec<_>>();
  let result = myoxus_infrastructure::app_config::write_config_batch(
    &pool,
    &mutations,
    myoxus_infrastructure::app_config::ConfigBatchMode::Partial,
    Some(admin_user_id),
    &crate::config::AppConfigStartupValidator,
  )
  .await
  .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
  crate::graphql::admin_config::record_committed_config_changes(&state, &result.changes, admin_user_id).await;

  // P84-H-12: Invalidate config caches after i18n config update.
  state.query_cache.server_config.invalidate_all();
  state.query_cache.metrics_server_config.record_invalidation_local();
  tracing::info!(
    cache_name = "server_config",
    reason = "updateI18nConfig",
    "cache invalidated"
  );
  // P84-I: Notify other instances via Redis Pub/Sub.
  state.publish_cache_invalidation("app_config", "all").await;
  state.publish_cache_invalidation("server_config", "all").await;
  if let Err(error) = state.refresh_config_overrides().await {
    // Do not report a failed request after the authoritative DB transaction
    // committed. The periodic recovery poll will retry the live projection.
    warn!(%error, "i18n config committed but local live refresh failed");
  }

  Ok((StatusCode::OK, Json(effective)))
}

/// Build the i18n response from the shared effective configuration snapshot.
#[instrument(skip_all)]
pub(crate) async fn effective_i18n_config(state: &ApiState) -> Result<I18nConfigResponse, StatusCode> {
  let effective = state.effective_config().await;
  let mut default_locale = effective
    .string("i18n.default_locale")
    .unwrap_or_else(|| state.config_file_baseline.i18n.default_locale.clone());
  let available_locales = effective
    .string_array("i18n.available_locales")
    .unwrap_or_else(|| state.config_file_baseline.i18n.available_locales.clone());

  let mut available_locales = normalize_locales(available_locales);
  if available_locales.is_empty() {
    available_locales.push("en".to_string());
  }
  if default_locale.trim().is_empty() {
    default_locale = available_locales.first().cloned().unwrap_or_else(|| "en".to_string());
  }
  if !available_locales.contains(&default_locale) {
    available_locales.insert(0, default_locale.clone());
    available_locales = normalize_locales(available_locales);
  }

  Ok(I18nConfigResponse {
    default_locale,
    available_locales,
  })
}

/// Deduplicate and trim a list of locale strings, preserving insertion order.
pub(crate) fn normalize_locales(locales: Vec<String>) -> Vec<String> {
  let mut seen = std::collections::HashSet::new();
  let mut out = Vec::new();
  for locale in locales {
    let normalized = locale.trim().to_string();
    if normalized.is_empty() {
      continue;
    }
    if seen.insert(normalized.clone()) {
      out.push(normalized);
    }
  }
  out
}

/// Return `true` if `locale` is one of the built-in supported BCP-47 locale codes.
pub(crate) fn is_supported_locale(locale: &str) -> bool {
  SUPPORTED_I18N_LOCALES.contains(&locale)
}

/// Extract the `content` attribute value of an HTML `<meta>` tag by `property` or `name`.
///
/// Matching is case-insensitive on both the key name and the `content=` attribute.
/// Returns `None` when the tag is not present or has no `content` attribute.
/// API-RV-04: All searching AND slicing happens on the same string representation
/// (lowercased) to avoid byte-index misalignment on multi-byte Unicode characters.
/// The extracted content is lowercased, which is acceptable for meta tags
/// (URLs, descriptions) where casing is not semantically critical.
pub(crate) fn parse_meta_content_case_insensitive(html: &str, key: &str) -> Option<String> {
  let html_lower = html.to_lowercase();
  let key1 = format!("property=\"{}\"", key.to_lowercase());
  let key2 = format!("name=\"{}\"", key.to_lowercase());
  let idx = html_lower.find(&key1).or_else(|| html_lower.find(&key2))?;
  let tail = &html_lower[idx..];
  let content_attr = "content=\"";
  let content_pos = tail.find(content_attr)?;
  let rest = &tail[content_pos + content_attr.len()..];
  let end = rest.find('"')?;
  Some(rest[..end].trim().to_string())
}

/// Extract the text content of the first `<title>` element from an HTML document.
///
/// API-RV-04: Searches and slices the same lowered string to avoid byte-index
/// misalignment. Returns the original-case title by using char-based offset mapping.
pub(crate) fn parse_title(html: &str) -> Option<String> {
  let lower = html.to_lowercase();
  let start = lower.find("<title>")?;
  let content_start = start + 7; // len("<title>")
  let end = lower[content_start..].find("</title>")?;
  // Map byte offsets from the lowered string back to the original.
  // For pure ASCII this is 1:1; for multi-byte characters we count chars.
  let char_start = lower[..content_start].chars().count();
  let char_len = lower[content_start..content_start + end].chars().count();
  let raw: String = html.chars().skip(char_start).take(char_len).collect();
  let trimmed = raw.trim();
  if trimmed.is_empty() {
    None
  } else {
    Some(trimmed.to_string())
  }
}

// ---------------------------------------------------------------------------
// Outbound URL validation (SEC-03)
// ---------------------------------------------------------------------------

type ProxyError = (StatusCode, Json<serde_json::Value>);

/// Validate `url` for the server-side proxy:
/// 1. scheme must be http or https
/// 2. the URL must carry a host
/// 3. self-referencing URLs on the server's own port are rejected (proxy loop
///    prevention)
///
/// Address class (public, private, loopback, link-local) is intentionally not
/// a criterion: own Git forge instances are commonly reached through local
/// addresses, private DNS names and IPv4/IPv6 literals, and they must receive
/// the same treatment as public URLs. Authentication, bounded redirects, TLS
/// verification and response-size bounds remain the protective layers.
async fn validate_proxy_url(url: &reqwest::Url, server_port: u16) -> Result<(), ProxyError> {
  if url.scheme() != "http" && url.scheme() != "https" {
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid URL"})),
    ));
  }
  let host = url.host_str().ok_or_else(|| {
    (
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid URL"})),
    )
  })?;
  // API-RV-07: Reject self-referencing URLs (proxy loop prevention).
  // Normalize port comparison: treat default ports (80/443) as equivalent.
  let target_port = url.port_or_known_default().unwrap_or(80);
  if (host == "localhost" || host == "127.0.0.1" || host == "::1" || host == "0.0.0.0") && target_port == server_port {
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid URL"})),
    ));
  }
  Ok(())
}

/// API-RV-01: Follow redirects manually with re-validation on each hop.
///
/// Automatic redirect following is disabled on the HTTP client so every hop
/// passes through [`validate_proxy_url`] again (scheme, host, self-port loop
/// protection). The hop count stays bounded by [`MAX_REDIRECTS`].
const MAX_REDIRECTS: usize = 3;

async fn fetch_with_validated_redirects(
  client: &reqwest::Client,
  method: reqwest::Method,
  initial_url: reqwest::Url,
  server_port: u16,
) -> Result<reqwest::Response, ProxyError> {
  let mut url = initial_url;
  for _ in 0..MAX_REDIRECTS {
    let resp = client.request(method.clone(), url.clone()).send().await.map_err(|_| {
      (
        StatusCode::BAD_REQUEST,
        Json(json!({"name":"BAD_REQUEST","message":"Error fetching URL"})),
      )
    })?;

    if !resp.status().is_redirection() {
      return Ok(resp);
    }

    let location = resp
      .headers()
      .get(reqwest::header::LOCATION)
      .and_then(|v| v.to_str().ok())
      .ok_or_else(|| {
        (
          StatusCode::BAD_REQUEST,
          Json(json!({"name":"BAD_REQUEST","message":"Redirect without Location header"})),
        )
      })?;

    url = url.join(location).map_err(|_| {
      (
        StatusCode::BAD_REQUEST,
        Json(json!({"name":"BAD_REQUEST","message":"Invalid redirect URL"})),
      )
    })?;

    // Re-validate the redirect target (scheme, host, self-port loop)
    validate_proxy_url(&url, server_port).await?;
  }

  Err((
    StatusCode::BAD_REQUEST,
    Json(json!({"name":"BAD_REQUEST","message":"Too many redirects"})),
  ))
}

/// Require a valid authenticated session; return 401 on failure.
///
/// These proxy endpoints must not be accessible to unauthenticated callers —
/// an open proxy is a trivially exploitable SSRF vector.
async fn require_proxy_auth(state: &crate::state::ApiState, headers: &HeaderMap) -> Result<(), ProxyError> {
  let cookies = crate::graphql::utils::parse_cookies(headers);
  let Some(session_id) = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
  else {
    return Err((
      StatusCode::UNAUTHORIZED,
      Json(json!({"name":"UNAUTHORIZED","message":"Authentication required"})),
    ));
  };
  state
    .auth()
    .get_session_snapshot(session_id)
    .await
    .ok()
    .flatten()
    .map(|_| ())
    .ok_or_else(|| {
      (
        StatusCode::UNAUTHORIZED,
        Json(json!({"name":"UNAUTHORIZED","message":"Authentication required"})),
      )
    })
}

/// `POST /api/worker/link-preview` — fetch Open Graph / HTML metadata for a URL.
///
/// Makes a server-side HTTP request to the given URL (up to 3 redirects,
/// 10-second timeout) and extracts Open Graph tags (`og:title`, `og:image`,
/// etc.) and the `<title>` element.  When `head: true` the handler issues a
/// HEAD request and returns 204 on success, avoiding body download.
///
/// Requires an authenticated session (SEC-03: prevents unauthenticated proxy
/// use). Validates the target URL scheme and host, rejects self-referencing
/// URLs on the server's own port, and follows bounded redirects with
/// re-validation on each hop. Local and public addresses receive the same
/// treatment; there is no address-class blocklist.
/// Rejects non-HTTP/HTTPS schemes and responses larger than 2 MiB.
#[instrument(skip_all)]
pub(crate) async fn worker_link_preview_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  ExtractJson(req): ExtractJson<LinkPreviewRequest>,
) -> Result<axum::response::Response, ProxyError> {
  // SEC-03: authentication gate — open proxy = SSRF for free
  require_proxy_auth(&state, &headers).await?;

  let target = reqwest::Url::parse(&req.url).map_err(|_| {
    (
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid URL"})),
    )
  })?;

  let server_port = state.config.server.port;
  validate_proxy_url(&target, server_port).await?;

  let client = state.http_client();
  let method = if req.head.unwrap_or(false) {
    reqwest::Method::HEAD
  } else {
    reqwest::Method::GET
  };
  let response = fetch_with_validated_redirects(client, method, target.clone(), server_port).await?;

  if req.head.unwrap_or(false) {
    if response.status().is_success() || response.status().is_redirection() {
      return Ok(StatusCode::NO_CONTENT.into_response());
    }
    return Ok(response.status().into_response());
  }

  let final_url = response.url().to_string();
  let content_type = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .map(|v| v.to_string());

  let body = response.bytes().await.map_err(|e| {
    warn!(url = %final_url, error = %e, "link preview fetch failed");
    (
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Error fetching URL"})),
    )
  })?;

  if body.len() > 2 * 1024 * 1024 {
    warn!(url = %final_url, size = body.len(), "link preview response too large");
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Response too large"})),
    ));
  }

  let html = String::from_utf8_lossy(&body);
  let parsed_final = reqwest::Url::parse(&final_url).ok();
  let mut favicons = Vec::new();
  if let Some(base) = parsed_final
    && let Ok(favicon) = base.join("/favicon.ico?v=2")
  {
    favicons.push(favicon.to_string());
  }

  let response_payload = LinkPreviewResponse {
    url: final_url,
    title: parse_meta_content_case_insensitive(&html, "og:title").or_else(|| parse_title(&html)),
    site_name: parse_meta_content_case_insensitive(&html, "og:site_name"),
    description: parse_meta_content_case_insensitive(&html, "og:description")
      .or_else(|| parse_meta_content_case_insensitive(&html, "description")),
    images: parse_meta_content_case_insensitive(&html, "og:image")
      .map(|v| vec![v])
      .unwrap_or_default(),
    media_type: parse_meta_content_case_insensitive(&html, "og:type"),
    content_type,
    charset: None,
    videos: parse_meta_content_case_insensitive(&html, "og:video")
      .map(|v| vec![v])
      .unwrap_or_default(),
    favicons,
  };

  Ok((StatusCode::OK, Json(response_payload)).into_response())
}

/// `GET /api/worker/image-proxy` — server-side image proxy for opaque image URLs.
///
/// Fetches the image at the given `url` query parameter server-side and
/// streams the raw bytes back to the caller with the upstream `Content-Type`
/// header.  Rejects non-HTTP/HTTPS schemes, non-`image/*` content types,
/// and responses larger than 10 MiB.
///
/// Requires an authenticated session (SEC-03: prevents unauthenticated proxy
/// use). Validates the target URL scheme and host, rejects self-referencing
/// URLs on the server's own port, and follows bounded redirects with
/// re-validation on each hop. Local and public addresses receive the same
/// treatment; there is no address-class blocklist.
#[instrument(skip_all)]
pub(crate) async fn worker_image_proxy_handler(
  State(state): State<ApiState>,
  headers: HeaderMap,
  Query(query): Query<WorkerImageProxyQuery>,
) -> Result<impl IntoResponse, ProxyError> {
  // SEC-03: authentication gate
  require_proxy_auth(&state, &headers).await?;

  let target = reqwest::Url::parse(&query.url).map_err(|_| {
    (
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid URL"})),
    )
  })?;

  let server_port = state.config.server.port;
  validate_proxy_url(&target, server_port).await?;

  let client = state.http_client();
  let response = fetch_with_validated_redirects(client, reqwest::Method::GET, target, server_port).await?;

  if !response.status().is_success() {
    warn!(url = %query.url, status = %response.status(), "image proxy: upstream returned error");
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Failed to fetch image"})),
    ));
  }
  let content_type = response
    .headers()
    .get(reqwest::header::CONTENT_TYPE)
    .and_then(|v| v.to_str().ok())
    .unwrap_or("application/octet-stream")
    .to_string();
  if !content_type.starts_with("image/") {
    warn!(url = %query.url, content_type = %content_type, "image proxy: non-image content type");
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Invalid content type"})),
    ));
  }
  let body = response.bytes().await.map_err(|e| {
    warn!(url = %query.url, error = %e, "image proxy: failed to read response body");
    (
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Failed to fetch image"})),
    )
  })?;
  if body.len() > 10 * 1024 * 1024 {
    warn!(url = %query.url, size = body.len(), "image proxy: response too large");
    return Err((
      StatusCode::BAD_REQUEST,
      Json(json!({"name":"BAD_REQUEST","message":"Response too large"})),
    ));
  }
  Ok(([(axum::http::header::CONTENT_TYPE, content_type)], body))
}

/// `GET /user` — thin alias that returns the currently authenticated user.
///
/// Reads the session cookie, refreshes the session if it is close to expiry,
/// and returns a [`SessionUserResponse`] JSON body.  Returns `null` when no
/// valid session cookie is present so that the client can distinguish "not
/// authenticated" from a hard error.
#[instrument(skip_all)]
pub(crate) async fn current_user_alias(
  State(state): State<ApiState>,
  headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
  let cookies = crate::graphql::utils::parse_cookies(&headers);
  let Some(session_id) = crate::graphql::utils::parse_uuid_cookie(&cookies, crate::graphql::utils::SESSION_COOKIE_NAME)
  else {
    return Ok(Json(serde_json::Value::Null));
  };

  let snapshot = state
    .auth()
    .refresh_session_if_needed(session_id)
    .await
    .map_err(|_| StatusCode::UNAUTHORIZED)?;
  let Some(snapshot) = snapshot else {
    return Ok(Json(serde_json::Value::Null));
  };
  Ok(Json(
    serde_json::to_value(crate::auth::SessionUserResponse::from(snapshot.user)).unwrap_or(serde_json::Value::Null),
  ))
}

/// Stub handler that rejects GET/DELETE requests to the workspace MCP endpoint.
///
/// Returns `405 Method Not Allowed` with a JSON-RPC 2.0 error envelope so
/// that MCP clients receive a well-formed error response rather than a plain
/// HTTP error.
#[instrument(skip_all)]
pub(crate) async fn mcp_method_not_allowed() -> impl IntoResponse {
  (
    StatusCode::METHOD_NOT_ALLOWED,
    Json(McpResponse {
      jsonrpc: "2.0",
      result: None,
      error: Some(McpErrorObject {
        code: -32000,
        message: "Method not allowed.".to_string(),
      }),
      id: None,
    }),
  )
}

/// `POST /api/workspaces/{workspace_id}/mcp` — workspace-scoped MCP JSON-RPC bridge.
///
/// Accepts a JSON-RPC 2.0 request envelope and dispatches on the `method`
/// field.  Currently handles:
///
/// - `initialize` — returns the MCP protocol version and server capabilities
/// - `tools/list` — returns an empty tool list (no tools registered yet)
/// - `*` — returns `-32601 Method not found`
///
/// Authentication is enforced: the caller must hold at least read permission
/// on the target workspace.  Returns `400 Bad Request` when the workspace UUID
/// is malformed and `401 Unauthorized` when the session is missing or invalid.
#[instrument(skip_all)]
pub(crate) async fn mcp_handler(
  State(state): State<ApiState>,
  Path(workspace_id): Path<String>,
  headers: HeaderMap,
  ExtractJson(req): ExtractJson<McpRequest>,
) -> Result<impl IntoResponse, StatusCode> {
  // MCP-RV-03: Check mcp.enabled before processing any MCP request
  if !state
    .effective_config()
    .await
    .bool("mcp.enabled")
    .unwrap_or(state.config_file_baseline.mcp.enabled)
  {
    return Err(StatusCode::NOT_FOUND);
  }
  let workspace_uuid = Uuid::parse_str(&workspace_id).map_err(|_| StatusCode::BAD_REQUEST)?;
  let _user_id = crate::require_workspace_read_user(&state, &headers, workspace_uuid).await?;
  let _protocol = req.jsonrpc.unwrap_or_else(|| "2.0".to_string());
  let method = req.method.unwrap_or_default();
  let id = req.id;
  let response = match method.as_str() {
    "initialize" => McpResponse {
      jsonrpc: "2.0",
      result: Some(json!({
          "protocolVersion": "2024-11-05",
          "serverInfo": { "name": "myoxus-mcp", "version": MYOXUS_SERVER_VERSION },
          "capabilities": {}
      })),
      error: None,
      id,
    },
    "tools/list" => McpResponse {
      jsonrpc: "2.0",
      result: Some(json!({ "tools": [] })),
      error: None,
      id,
    },
    unknown => {
      warn!(workspace_id = %workspace_id, method = %unknown, "MCP: unknown method requested");
      McpResponse {
        jsonrpc: "2.0",
        result: None,
        error: Some(McpErrorObject {
          code: -32601,
          message: "Method not found".to_string(),
        }),
        id,
      }
    }
  };
  Ok((StatusCode::OK, Json(response)))
}

#[cfg(test)]
mod tests {
  use super::*;

  /// API-RV-04c: non-ASCII prefix before meta/title tag must not cause panic.
  #[test]
  fn parse_meta_non_ascii_prefix() {
    let html = r#"<html><head><!-- Ünïcödé --><meta property="og:title" content="Hëllo Wörld"></head></html>"#;
    let result = parse_meta_content_case_insensitive(html, "og:title");
    // Content is extracted from the lowered string, so it's lowercased
    assert_eq!(result.as_deref(), Some("hëllo wörld"));
  }

  #[test]
  fn parse_title_non_ascii() {
    let html = "<html><head><title>Ünïcödé Tïtlé</title></head></html>";
    let result = parse_title(html);
    assert_eq!(result.as_deref(), Some("Ünïcödé Tïtlé"));
  }

  #[test]
  fn parse_title_case_insensitive_tags() {
    let html = "<HTML><HEAD><TITLE>My Page</TITLE></HEAD></HTML>";
    let result = parse_title(html);
    assert_eq!(result.as_deref(), Some("My Page"));
  }

  #[test]
  fn parse_meta_missing_returns_none() {
    let html = "<html><head></head></html>";
    assert!(parse_meta_content_case_insensitive(html, "og:title").is_none());
    assert!(parse_title(html).is_none());
  }

  /// API-RV-07: Self-proxy loop detection.
  #[tokio::test]
  async fn validate_rejects_localhost_3001() {
    let url = reqwest::Url::parse("http://localhost:3001/api/health").unwrap();
    assert!(validate_proxy_url(&url, 3001).await.is_err());
  }

  #[tokio::test]
  async fn validate_rejects_127_3001() {
    let url = reqwest::Url::parse("http://127.0.0.1:3001/some/path").unwrap();
    assert!(validate_proxy_url(&url, 3001).await.is_err());
  }

  /// API-RV-07: Loop detection uses configured port, not hardcoded 3001.
  #[tokio::test]
  async fn validate_rejects_localhost_custom_port() {
    let url = reqwest::Url::parse("http://localhost:9090/api/health").unwrap();
    assert!(validate_proxy_url(&url, 9090).await.is_err());
  }

  /// API-RV-07: Different port on localhost must pass — own instances are
  /// commonly reached through loopback addresses on other ports.
  #[tokio::test]
  async fn validate_allows_localhost_different_port() {
    let url = reqwest::Url::parse("http://localhost:8080/api/health").unwrap();
    assert!(validate_proxy_url(&url, 3001).await.is_ok());
  }

  /// Private and link-local address classes receive the same treatment as
  /// public ones; only scheme, host presence and the self-port loop are
  /// rejected.
  #[tokio::test]
  async fn validate_allows_private_address_classes() {
    for raw in [
      "http://169.254.169.254/latest/meta-data/",
      "http://[::1]:8080/",
      "http://[fc00::1]:8080/",
      "http://10.0.0.1/secret",
    ] {
      let url = reqwest::Url::parse(raw).unwrap();
      assert!(validate_proxy_url(&url, 3001).await.is_ok(), "{raw} must be accepted");
    }
  }

  #[tokio::test]
  async fn validate_allows_public_url() {
    // No DNS lookup remains in validation; this must not panic or fail.
    let url = reqwest::Url::parse("https://example.com").unwrap();
    assert!(validate_proxy_url(&url, 3001).await.is_ok());
  }
}
