// SPDX-License-Identifier: AGPL-3.0-or-later
//! Strict GitLab project-token self-rotation adapter.
//!
//! The adapter sends exactly one provider request and never invokes Git. A
//! failure is retryable only when reqwest proves that connection setup failed
//! before an HTTP request could be transmitted. Every response-side failure is
//! manual intervention because GitLab revokes the previous token immediately.

use std::{fmt, time::Duration};

use async_trait::async_trait;
use chrono::{DateTime, NaiveDate, Utc};
use futures_util::StreamExt;
use myoxus_application::git_sync::{
  GitTokenRotationProvider, GitTokenRotationProviderError, GitTokenRotationProviderFailureKind,
  GitTokenRotationProviderKind, GitTokenRotationProviderRequest, GitTokenRotationProviderResult,
};
use reqwest::header::{CONTENT_LENGTH, HeaderValue};
use serde::Deserialize;

use crate::tls::{ValidatedCaBundle, add_reqwest_roots};

const MAX_RESPONSE_BYTES: usize = 64 * 1024;
const MAX_TOKEN_BYTES: usize = 8 * 1024;
const MAX_REPOSITORY_URL_BYTES: usize = 4 * 1024;
const MAX_REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const MAX_CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Clone)]
pub struct GitLabTokenRotationAdapter {
  client: reqwest::Client,
}

impl fmt::Debug for GitLabTokenRotationAdapter {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter
      .debug_struct("GitLabTokenRotationAdapter")
      .field("redirect_policy", &"none")
      .field("max_response_bytes", &MAX_RESPONSE_BYTES)
      .finish()
  }
}

impl GitLabTokenRotationAdapter {
  pub fn new(
    request_timeout: Duration,
    ca_bundle: Option<&ValidatedCaBundle>,
  ) -> Result<Self, GitTokenRotationProviderError> {
    let request_timeout = request_timeout.clamp(Duration::from_secs(1), MAX_REQUEST_TIMEOUT);
    let mut builder = reqwest::Client::builder()
      .timeout(request_timeout)
      .connect_timeout(request_timeout.min(MAX_CONNECT_TIMEOUT))
      .redirect(reqwest::redirect::Policy::none());
    if let Some(bundle) = ca_bundle {
      builder = add_reqwest_roots(builder, bundle).map_err(|message| before_request(&message))?;
    }
    let client = builder
      .build()
      .map_err(|_| before_request("GitLab HTTP client could not be initialized"))?;
    Ok(Self { client })
  }
}

#[derive(Debug, Deserialize)]
struct GitLabRotationResponse {
  token: String,
  expires_at: String,
}

#[async_trait]
impl GitTokenRotationProvider for GitLabTokenRotationAdapter {
  fn kind(&self) -> GitTokenRotationProviderKind {
    GitTokenRotationProviderKind::GitLab
  }

  async fn rotate(
    &self,
    request: GitTokenRotationProviderRequest,
  ) -> Result<GitTokenRotationProviderResult, GitTokenRotationProviderError> {
    let endpoint = self_rotation_endpoint(&request.repository_url)?;
    if request.credential.token.is_empty() || request.credential.token.len() > MAX_TOKEN_BYTES {
      return Err(before_request("active GitLab token has an invalid length"));
    }
    let mut token_header = HeaderValue::from_str(&request.credential.token)
      .map_err(|_| before_request("active GitLab token cannot be represented as an HTTP header"))?;
    token_header.set_sensitive(true);
    let expires_at = request.requested_expires_at.date_naive().format("%Y-%m-%d").to_string();
    let response = self
      .client
      .post(endpoint)
      .header("PRIVATE-TOKEN", token_header)
      .form(&[("expires_at", expires_at)])
      .send()
      .await
      .map_err(classify_send_error)?;
    if !response.status().is_success() {
      return Err(manual_intervention(format!(
        "GitLab rejected token rotation with HTTP {}",
        response.status().as_u16()
      )));
    }
    if response
      .headers()
      .get(CONTENT_LENGTH)
      .and_then(|value| value.to_str().ok())
      .and_then(|value| value.parse::<usize>().ok())
      .is_some_and(|length| length > MAX_RESPONSE_BYTES)
    {
      return Err(manual_intervention(
        "GitLab token rotation response exceeded the size limit",
      ));
    }
    let mut body = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
      let chunk = chunk.map_err(|_| manual_intervention("GitLab token rotation response was incomplete"))?;
      if body.len().saturating_add(chunk.len()) > MAX_RESPONSE_BYTES {
        return Err(manual_intervention(
          "GitLab token rotation response exceeded the size limit",
        ));
      }
      body.extend_from_slice(&chunk);
    }
    let response: GitLabRotationResponse = serde_json::from_slice(&body)
      .map_err(|_| manual_intervention("GitLab token rotation returned malformed success data"))?;
    if response.token.is_empty() || response.token.len() > MAX_TOKEN_BYTES || response.token == request.credential.token
    {
      return Err(manual_intervention(
        "GitLab token rotation returned an invalid replacement",
      ));
    }
    let expires_on = NaiveDate::parse_from_str(&response.expires_at, "%Y-%m-%d")
      .map_err(|_| manual_intervention("GitLab token rotation returned an invalid expiry"))?;
    let expires_at = expires_on
      .and_hms_opt(0, 0, 0)
      .map(|value| DateTime::<Utc>::from_naive_utc_and_offset(value, Utc))
      .ok_or_else(|| manual_intervention("GitLab token rotation returned an invalid expiry"))?;
    if expires_at <= Utc::now() {
      return Err(manual_intervention(
        "GitLab token rotation returned a non-future expiry",
      ));
    }
    Ok(GitTokenRotationProviderResult {
      replacement_token: response.token,
      expires_at,
    })
  }
}

fn self_rotation_endpoint(repository_url: &str) -> Result<reqwest::Url, GitTokenRotationProviderError> {
  if repository_url.len() > MAX_REPOSITORY_URL_BYTES {
    return Err(before_request("GitLab repository URL exceeds the supported length"));
  }
  let repository =
    reqwest::Url::parse(repository_url).map_err(|_| before_request("GitLab repository URL is invalid"))?;
  if repository.scheme() != "https"
    || repository.host_str().is_none()
    || !repository.username().is_empty()
    || repository.password().is_some()
    || repository.query().is_some()
    || repository.fragment().is_some()
  {
    return Err(before_request(
      "GitLab token rotation requires a credential-free HTTPS repository URL",
    ));
  }
  // Read the path from the original spelling. URL parsers normalize dot
  // segments, which would otherwise silently rotate a different project than
  // the repository identity the profile was validated against.
  let after_scheme = repository_url
    .split_once("://")
    .map(|(_, value)| value)
    .ok_or_else(|| before_request("GitLab repository URL is invalid"))?;
  let raw_path = after_scheme
    .find('/')
    .map(|offset| &after_scheme[offset + 1..])
    .unwrap_or_default();
  let decoded_path = urlencoding::decode(raw_path)
    .map_err(|_| before_request("GitLab repository path contains invalid percent encoding"))?;
  let decoded_path = decoded_path.trim_matches('/');
  let project_path = decoded_path.strip_suffix(".git").unwrap_or(decoded_path);
  if project_path.is_empty()
    || project_path
      .split('/')
      .any(|segment| segment.is_empty() || segment == "." || segment == "..")
  {
    return Err(before_request("GitLab repository path is invalid"));
  }
  let encoded_project = urlencoding::encode(project_path);
  reqwest::Url::parse(&format!(
    "{}/api/v4/projects/{encoded_project}/access_tokens/self/rotate",
    repository.origin().ascii_serialization()
  ))
  .map_err(|_| before_request("GitLab self-rotation endpoint could not be derived"))
}

fn classify_send_error(error: reqwest::Error) -> GitTokenRotationProviderError {
  if error.is_connect() {
    before_request("GitLab connection failed before token rotation was transmitted")
  } else {
    manual_intervention("GitLab token rotation HTTP outcome is unknown")
  }
}

fn before_request(diagnosis: impl Into<String>) -> GitTokenRotationProviderError {
  GitTokenRotationProviderError {
    kind: GitTokenRotationProviderFailureKind::BeforeRequest,
    diagnosis: diagnosis.into(),
  }
}

fn manual_intervention(diagnosis: impl Into<String>) -> GitTokenRotationProviderError {
  GitTokenRotationProviderError {
    kind: GitTokenRotationProviderFailureKind::ManualIntervention,
    diagnosis: diagnosis.into(),
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn derives_only_the_same_origin_encoded_project_endpoint() {
    let endpoint = self_rotation_endpoint("https://gitlab.example.test:8443/group/sub/project.git")
      .expect("valid GitLab project URL");
    assert_eq!(
      endpoint.as_str(),
      "https://gitlab.example.test:8443/api/v4/projects/group%2Fsub%2Fproject/access_tokens/self/rotate"
    );
    for invalid in [
      "http://gitlab.example.test/group/project.git",
      "https://user:secret@gitlab.example.test/group/project.git",
      "https://gitlab.example.test/group/../project.git",
      "https://gitlab.example.test/",
      "https://gitlab.example.test/group/project.git?token=secret",
    ] {
      assert!(self_rotation_endpoint(invalid).is_err(), "must reject {invalid}");
    }
  }
}
