// SPDX-FileCopyrightText: 2026 Daniel Scharf and Myoxus contributors
// SPDX-License-Identifier: AGPL-3.0-or-later

//! Client-visible, workspace-local document keys.

use serde::{Deserialize, Serialize};
use std::fmt;

/// Maximum persisted length for a client-visible document key.
pub const MAX_DOCUMENT_KEY_LENGTH: usize = 512;

/// A validated document key whose identity is meaningful only with its space.
///
/// This type deliberately performs no UUID parsing or UUIDv5 derivation. The
/// SQL identity boundary resolves `(workspace_id, external_id)` to the global
/// server-internal `docs.id` surrogate.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct DocumentKey(String);

impl DocumentKey {
  pub fn parse(value: impl Into<String>) -> Result<Self, String> {
    let value = value.into();
    if value.trim().is_empty() {
      return Err("document key must not be empty".to_string());
    }
    if value.len() > MAX_DOCUMENT_KEY_LENGTH {
      return Err(format!("document key exceeds {MAX_DOCUMENT_KEY_LENGTH} bytes"));
    }
    Ok(Self(value))
  }

  pub fn as_str(&self) -> &str {
    &self.0
  }

  pub fn into_string(self) -> String {
    self.0
  }
}

impl fmt::Display for DocumentKey {
  fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
    formatter.write_str(self.as_str())
  }
}

impl TryFrom<String> for DocumentKey {
  type Error = String;

  fn try_from(value: String) -> Result<Self, Self::Error> {
    Self::parse(value)
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn accepts_uuid_nanoid_and_system_keys_without_rewriting() {
    for value in [
      "f229c8f9-95b8-4cc9-a88e-c7c92a718933",
      "aBiKq4O6jiRg0KDzM3Pm5",
      "db$workspace$folders",
    ] {
      assert_eq!(DocumentKey::parse(value).unwrap().as_str(), value);
    }
  }

  #[test]
  fn rejects_blank_and_oversized_keys() {
    assert!(DocumentKey::parse("  ").is_err());
    assert!(DocumentKey::parse("x".repeat(MAX_DOCUMENT_KEY_LENGTH + 1)).is_err());
  }
}
