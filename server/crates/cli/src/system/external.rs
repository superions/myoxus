// SPDX-License-Identifier: AGPL-3.0-or-later
//! Public deployment routing checks, not authenticated GUI or IdP qualification.

use myoxus_infrastructure::tls::ValidatedCaBundle;
use reqwest::{Client, StatusCode, Url};
use serde_json::Value;

use super::{DOCTOR_CHECK_TIMEOUT, DoctorRow, DoctorStatus, Instant, http};

const HTML_LIMIT: usize = 256 * 1024;
const MAX_REDIRECTS: usize = 4;

pub(super) async fn inspect(input: Option<&str>, trust: Option<&Option<ValidatedCaBundle>>, rows: &mut Vec<DoctorRow>) {
  let Some(input) = input else {
    return;
  };
  let started = Instant::now();
  let base = match http::base_url(input) {
    Ok(base) => base,
    Err(error) => {
      rows.push(DoctorRow::new("external.origin", DoctorStatus::Fail, started, error));
      return;
    }
  };
  // server.origin is restart-owned. Compare the actual CLI startup projection,
  // not an unmirrored DB candidate or a claim about the running API's state.
  let configured = tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(|| {
      let sources = myoxus_contracts::runtime_config::load_server_config_sources()?;
      sources.config.get_string("server.origin")
    }),
  )
  .await;
  let (status, detail) = match configured {
    Ok(Ok(Ok(origin))) => match http::base_url(&origin) {
      Ok(origin) if origin == base => (
        DoctorStatus::Pass,
        format!("supplied {base} matches CLI startup server.origin; running API compared separately via /info"),
      ),
      Ok(origin) => (
        DoctorStatus::Fail,
        format!("supplied {base} differs from CLI startup server.origin={origin}"),
      ),
      Err(error) => (
        DoctorStatus::Fail,
        format!("configured server.origin is invalid: {error}"),
      ),
    },
    Ok(Ok(Err(error))) => (
      DoctorStatus::Fail,
      format!("server.origin configuration unavailable: {error}"),
    ),
    Ok(Err(_)) => (
      DoctorStatus::Fail,
      "server.origin task panicked or was cancelled".into(),
    ),
    Err(_) => (DoctorStatus::Fail, "server.origin read exceeded 5 seconds".into()),
  };
  rows.push(DoctorRow::new("external.origin", status, started, detail));
  let Some(bundle) = trust else {
    rows.push(DoctorRow::new(
      "external.routes",
      DoctorStatus::Skip,
      started,
      "requires valid bootstrap TLS; no fallback applied",
    ));
    return;
  };
  let bundle = bundle.clone();
  let client = tokio::time::timeout(
    DOCTOR_CHECK_TIMEOUT,
    tokio::task::spawn_blocking(move || http::client(bundle.as_ref())),
  )
  .await;
  let client = match client {
    Ok(Ok(Ok(client))) => client,
    result => {
      let detail = match result {
        Ok(Ok(Err(error))) => error,
        Ok(Err(_)) => "external HTTP client task panicked or was cancelled".into(),
        Err(_) => "external HTTP client construction exceeded 5 seconds".into(),
        _ => unreachable!(),
      };
      rows.push(DoctorRow::new("external.routes", DoctorStatus::Fail, started, detail));
      return;
    }
  };
  let mut tasks = tokio::task::JoinSet::new();
  for (index, (id, path)) in [
    ("external.health", "health"),
    ("external.ready", "ready"),
    ("external.info", "info"),
    ("external.admin", "admin"),
    ("external.admin_security", "adminfrontend/security"),
  ]
  .into_iter()
  .enumerate()
  {
    let base = base.clone();
    let client = client.clone();
    tasks.spawn(async move {
      let started = Instant::now();
      let result = tokio::time::timeout(DOCTOR_CHECK_TIMEOUT, route(&client, &base, path)).await;
      let (status, detail) = match result {
        Ok(Ok(detail)) => (DoctorStatus::Pass, detail),
        Ok(Err(error)) => (DoctorStatus::Fail, error),
        Err(_) => (
          DoctorStatus::Fail,
          "external route/redirect/body deadline exceeded 5 seconds".into(),
        ),
      };
      (index, DoctorRow::new(id, status, started, detail))
    });
  }
  let mut measured = Vec::new();
  while let Some(result) = tasks.join_next().await {
    match result {
      Ok(result) => measured.push(result),
      Err(error) => rows.push(DoctorRow::new(
        "external.routes",
        DoctorStatus::Fail,
        started,
        format!("external route task failed: {error}"),
      )),
    }
  }
  measured.sort_by_key(|(index, _)| *index);
  rows.extend(measured.into_iter().map(|(_, row)| row));
}

async fn route(client: &Client, base: &Url, path: &str) -> Result<String, String> {
  let mut url = base.join(path).map_err(|_| "invalid external endpoint".to_string())?;
  let expected = base
    .join(if path == "admin" { "adminfrontend/" } else { path })
    .map_err(|_| "invalid final route".to_string())?;
  let admin_alias = base
    .join("adminfrontend")
    .map_err(|_| "invalid Admin route".to_string())?;
  let initial = url.clone();
  let mut visited = Vec::new();
  for hop in 0..=MAX_REDIRECTS {
    // Whitelist only this probe's real delivery routes. Same-origin alone is
    // insufficient: it could otherwise follow an OAuth/IdP proxy endpoint.
    if url.origin() != base.origin()
      || !url.path().starts_with(base.path())
      || !url.username().is_empty()
      || url.password().is_some()
      || url.query().is_some()
      || url.fragment().is_some()
      || !(url == initial || url == expected || path == "admin" && url == admin_alias)
    {
      return Err("redirect rejected before request: unexpected origin, prefix, route or credentials/query/fragment; target not displayed".into());
    }
    if visited.contains(&url) {
      return Err("redirect loop rejected before repeated request".into());
    }
    visited.push(url.clone());
    let response = http::get(
      client,
      url.clone(),
      if path.starts_with("admin") {
        HTML_LIMIT
      } else {
        http::JSON_LIMIT
      },
    )
    .await
    .map_err(|error| format!("endpoint={url}; {}: {}", error.http_status, error.detail))?;
    if response.status.is_redirection() {
      if !matches!(response.status.as_u16(), 301 | 302 | 303 | 307 | 308) || hop == MAX_REDIRECTS {
        return Err("unsupported redirect or four-hop limit exceeded".into());
      }
      let location = response
        .location
        .ok_or_else(|| "missing/invalid redirect location".to_string())?;
      url = url
        .join(&location)
        .map_err(|_| "invalid redirect location; target not displayed".to_string())?;
      continue;
    }
    if url != expected {
      return Err("response did not reach the expected final route".into());
    }
    if response.status != StatusCode::OK {
      return Err(format!(
        "endpoint={url}; rejected HTTP status {}; body not displayed",
        response.status
      ));
    }
    let detail = match path {
      // The delivered frontend Nginx intentionally owns literal gateway
      // liveness, whereas direct API /health uses the JSON startup snapshot.
      "health" if response.body == b"ok" => "gateway liveness only; API readiness checked separately".into(),
      "health" => http::health_contract(&response, false)?,
      "ready" => http::health_contract(&response, true)?,
      "info" => info_contract(&response.body, base)?,
      _ => admin_contract(&response, base)?,
    };
    return Ok(format!("endpoint={url}; redirects={hop}; {detail}"));
  }
  Err("redirect limit exceeded".into())
}

fn info_contract(bytes: &[u8], base: &Url) -> Result<String, String> {
  let body: Value = serde_json::from_slice(bytes).map_err(|_| "invalid /info JSON; body not displayed".to_string())?;
  if body.get("flavor").and_then(Value::as_str) != Some("myoxus-rust")
    || body.get("version").and_then(Value::as_str).is_none_or(str::is_empty)
    || body.get("description").and_then(Value::as_str).is_none()
    || body.get("name").and_then(Value::as_str).is_none()
    || body.get("initialized").and_then(Value::as_bool).is_none()
  {
    return Err("invalid /info server contract; body not displayed".into());
  }
  let configured = body
    .get("base_url")
    .and_then(Value::as_str)
    .ok_or_else(|| "missing /info.base_url".to_string())?;
  let configured = http::base_url(configured).map_err(|_| "invalid /info.base_url; value not displayed".to_string())?;
  if configured != *base {
    return Err(format!("/info.base_url={configured} differs from supplied {base}"));
  }
  Ok("API JSON recognized; /info.base_url matches supplied origin/prefix".into())
}

fn admin_contract(response: &http::Response, base: &Url) -> Result<String, String> {
  if !response.content_type.as_deref().is_some_and(|value| {
    value
      .split(';')
      .next()
      .is_some_and(|value| value.trim().eq_ignore_ascii_case("text/html"))
  }) {
    return Err("Admin route did not return HTML".into());
  }
  let html = std::str::from_utf8(&response.body)
    .map_err(|_| "invalid Admin HTML encoding".to_string())?
    .to_ascii_lowercase()
    .replace('\'', "\"");
  let admin_paths = [
    "/admin/".to_string(),
    "/adminfrontend/".to_string(),
    format!("{}admin/", base.path()),
    format!("{}adminfrontend/", base.path()),
  ];
  let metadata = html
    .split("<meta")
    .skip(1)
    .filter_map(|part| part.split('>').next())
    .any(|tag| {
      tag.contains("name=\"env:publicpath\"")
        && admin_paths
          .iter()
          .any(|path| tag.contains(&format!("content=\"{path}\"")))
    });
  if !html.contains("<html") || !html.contains("<script") || !html.contains("id=\"app\"") || !metadata {
    return Err("HTML is not a recognizable Admin entry shell; body not displayed".into());
  }
  Ok("Admin HTML shell recognized at expected route; assets, authentication and GUI behavior not verified".into())
}
