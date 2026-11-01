// SPDX-License-Identifier: AGPL-3.0-or-later
//! Transport-neutral PDF use-case errors. GraphQL retains its shipped extension values.
use crate::auth::AuthError;
use std::collections::BTreeMap;

#[derive(Debug, Default)]
pub struct PdfExportErrorDetails(pub BTreeMap<String, serde_json::Value>);
impl PdfExportErrorDetails {
  pub fn set(&mut self, key: &str, value: impl Into<serde_json::Value>) {
    self.0.insert(key.to_owned(), value.into());
  }
}
#[derive(Debug)]
pub struct PdfExportError {
  pub message: String,
  pub extensions: Option<PdfExportErrorDetails>,
  pub authorization: Option<AuthError>,
}
impl PdfExportError {
  pub fn new(message: impl Into<String>) -> Self {
    Self {
      message: message.into(),
      extensions: None,
      authorization: None,
    }
  }
  pub fn authorization(error: AuthError) -> Self {
    Self {
      message: error.to_string(),
      extensions: None,
      authorization: Some(error),
    }
  }
}
impl std::fmt::Display for PdfExportError {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    f.write_str(&self.message)
  }
}
impl std::error::Error for PdfExportError {}
pub type Result<T> = std::result::Result<T, PdfExportError>;
