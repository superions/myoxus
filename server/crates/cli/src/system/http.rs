// SPDX-License-Identifier: AGPL-3.0-or-later
//! Bounded HTTP reads and public probe-contract validation, never body dumps.

use myoxus_infrastructure::tls::ValidatedCaBundle;
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;

use super::DOCTOR_CHECK_TIMEOUT;

pub(super) const JSON_LIMIT: usize = 64 * 1024;

/// Preserve a deployment prefix while excluding credential/query-bearing URLs
/// from both requests and diagnostics. Parse errors never quote the input.
pub(super) fn base_url(input: &str) -> Result<Url, String> {
  let mut url = Url::parse(input).map_err(|_| "invalid HTTP base URL".to_string())?;
  if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
    return Err("HTTP base URL requires an http(s) host".into());
  }
  if !url.username().is_empty() || url.password().is_some() || url.query().is_some() || url.fragment().is_some() {
    return Err("HTTP base URL must not contain credentials, query or fragment".into());
  }
  if !url.path().ends_with('/') {
    url.set_path(&format!("{}/", url.path()));
  }
  Ok(url)
}

pub(super) fn client(additional_ca: Option<&ValidatedCaBundle>) -> Result<Client, String> {
  myoxus_infrastructure::tls::build_http_client(
    Client::builder()
      .timeout(DOCTOR_CHECK_TIMEOUT)
      .redirect(reqwest::redirect::Policy::none()),
    additional_ca,
  )
}

pub(super) struct Response {
  pub status: StatusCode,
  pub body: Vec<u8>,
  pub location: Option<String>,
  pub content_type: Option<String>,
}

pub(super) struct Failure {
  pub http_status: String,
  pub detail: String,
}

/// One request including its response read shares a five-second deadline.
/// Redirects are deliberately not automatic; callers must admit each hop.
pub(super) async fn get(client: &Client, url: Url, limit: usize) -> Result<Response, Failure> {
  match tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, async {
    let mut response = client.get(url).send().await.map_err(|error| Failure {
      http_status: "connection_error".into(),
      detail: transport_error(error),
    })?;
    let status = response.status();
    let location = response
      .headers()
      .get(reqwest::header::LOCATION)
      .and_then(|value| value.to_str().ok())
      .map(str::to_owned);
    let content_type = response
      .headers()
      .get(reqwest::header::CONTENT_TYPE)
      .and_then(|value| value.to_str().ok())
      .map(str::to_owned);
    if status.is_redirection() {
      return Ok(Response {
        status,
        body: Vec::new(),
        location,
        content_type,
      });
    }
    let failure = |detail: String| Failure {
      http_status: status.to_string(),
      detail,
    };
    if response.content_length().is_some_and(|length| length > limit as u64) {
      return Err(failure(format!("response exceeds {limit}-byte limit")));
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
      .chunk()
      .await
      .map_err(|error| failure(transport_error(error)))?
    {
      if chunk.len() > limit.saturating_sub(body.len()) {
        return Err(failure(format!("response exceeds {limit}-byte limit")));
      }
      body.extend_from_slice(&chunk);
    }
    Ok(Response {
      status,
      body,
      location,
      content_type,
    })
  })
  .await
  {
    Ok(result) => result,
    Err(_) => Err(Failure {
      http_status: "timeout".into(),
      detail: "HTTP request/body read exceeded 5 seconds".into(),
    }),
  }
}

fn transport_error(error: reqwest::Error) -> String {
  use std::error::Error;
  let reason = myoxus_infrastructure::tls::http_error::reason(&error);
  let mut source = error.source();
  for _ in 0..16 {
    let Some(cause) = source else {
      break;
    };
    if let Some(io) = cause.downcast_ref::<std::io::Error>() {
      if io.raw_os_error().is_some() {
        return format!("{reason}: {io}");
      }
    }
    source = cause.source();
  }
  reason.into()
}

/// Liveness may legitimately contain failed startup checks. Readiness must
/// agree with both HTTP 200 and the successful stored startup snapshot.
pub(super) fn health_contract(response: &Response, ready: bool) -> Result<String, String> {
  if response.status != StatusCode::OK {
    return Err(format!("rejected HTTP status {}; body not displayed", response.status));
  }
  let body: Value =
    serde_json::from_slice(&response.body).map_err(|_| "invalid JSON response; body not displayed".to_string())?;
  let expected = if ready { "ready" } else { "ok" };
  if body.get("status").and_then(Value::as_str) != Some(expected) {
    return Err("unexpected health/readiness status; body not displayed".into());
  }
  let checks = body
    .get("checks")
    .and_then(Value::as_array)
    .ok_or_else(|| "missing startup check array".to_string())?;
  for check in checks {
    let text = |key| check.get(key).and_then(Value::as_str);
    // Startup snapshots use the producer's pass/fail vocabulary, not the
    // surrounding endpoint's ok/ready status.
    if !matches!(text("status"), Some("pass" | "fail"))
      || !matches!(text("category"), Some("config" | "network" | "permissions" | "storage"))
      || text("name").is_none_or(str::is_empty)
      || text("code").is_none_or(str::is_empty)
      || text("detail").is_none()
      || text("checkedAt").is_none_or(|value| chrono::DateTime::parse_from_rfc3339(value).is_err())
    {
      return Err("invalid startup check contract; body not displayed".into());
    }
    if ready && text("status") != Some("pass") {
      return Err("ready status contradicts a failed startup check".into());
    }
  }
  if !ready {
    let uptime = body
      .get("uptime_seconds")
      .and_then(Value::as_u64)
      .ok_or_else(|| "missing/invalid uptime_seconds".to_string())?;
    Ok(format!(
      "status=ok uptime_seconds={uptime} startup_checks={}; stored startup snapshot, not live dependency proof",
      checks.len()
    ))
  } else {
    Ok(format!(
      "status=ready startup_checks={}; stored startup snapshot, not live dependency proof",
      checks.len()
    ))
  }
}
