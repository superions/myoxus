// SPDX-License-Identifier: AGPL-3.0-or-later
//! Normalized client identity/capability context for request-bound API logic.

use axum::http::{HeaderMap, header::USER_AGENT};
use myoxus_application::document_metadata::DocumentMetadataClientFormat;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClientContext {
  pub client: Option<String>,
  pub format: DocumentMetadataClientFormat,
  pub capabilities: Vec<String>,
  pub myoxus_version: Option<String>,
  pub affine_version: Option<String>,
  pub user_agent: Option<String>,
}

impl ClientContext {
  pub fn from_headers(headers: &HeaderMap) -> Self {
    let client = header_value(headers, "x-myoxus-client");
    let raw_format = header_value(headers, "x-myoxus-client-format");
    let format = match raw_format.as_deref() {
      Some("myoxus-native") => DocumentMetadataClientFormat::MyoxusNative,
      _ => DocumentMetadataClientFormat::AffineLegacy,
    };
    let capabilities = header_value(headers, "x-myoxus-client-capabilities")
      .map(|raw| {
        raw
          .split(',')
          .map(str::trim)
          .filter(|value| !value.is_empty())
          .map(str::to_string)
          .collect()
      })
      .unwrap_or_default();

    Self {
      client,
      format,
      capabilities,
      myoxus_version: header_value(headers, "x-myoxus-version"),
      affine_version: header_value(headers, "x-affine-version"),
      user_agent: headers
        .get(USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string),
    }
  }
}

fn header_value(headers: &HeaderMap, name: &str) -> Option<String> {
  headers
    .get(name)
    .and_then(|value| value.to_str().ok())
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(str::to_string)
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn parses_native_myoxus_client_context() {
    let mut headers = HeaderMap::new();
    headers.insert("x-myoxus-client", "web".parse().unwrap());
    headers.insert("x-myoxus-client-format", "myoxus-native".parse().unwrap());
    headers.insert(
      "x-myoxus-client-capabilities",
      "document-metadata, pdf-export".parse().unwrap(),
    );
    headers.insert("x-myoxus-version", "0.30.0".parse().unwrap());
    headers.insert(USER_AGENT, "MyoxusWeb/0.30".parse().unwrap());

    let context = ClientContext::from_headers(&headers);

    assert_eq!(context.client.as_deref(), Some("web"));
    assert_eq!(context.format, DocumentMetadataClientFormat::MyoxusNative);
    assert_eq!(context.capabilities, vec!["document-metadata", "pdf-export"]);
    assert_eq!(context.myoxus_version.as_deref(), Some("0.30.0"));
    assert_eq!(context.user_agent.as_deref(), Some("MyoxusWeb/0.30"));
  }

  #[test]
  fn defaults_unknown_or_legacy_clients_to_affine_compatible_projection() {
    let mut headers = HeaderMap::new();
    headers.insert("x-myoxus-client-format", "unknown-future-format".parse().unwrap());
    headers.insert("x-affine-version", "0.17.0".parse().unwrap());

    let context = ClientContext::from_headers(&headers);

    assert_eq!(context.format, DocumentMetadataClientFormat::AffineLegacy);
    assert_eq!(context.affine_version.as_deref(), Some("0.17.0"));
  }
}
