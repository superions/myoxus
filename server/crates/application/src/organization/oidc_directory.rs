// SPDX-License-Identifier: AGPL-3.0-or-later
//! On-demand provider catalog projection, independent from login reconciliation.

use std::collections::HashMap;

use async_trait::async_trait;
use myoxus_contracts::oauth_config::OAuthGroupDirectoryConfig;
use thiserror::Error;

use super::oidc_sync::normalize_group_name;

pub const MAX_DIRECTORY_GROUPS: usize = 10_000;

/// No raw provider response, URL or credentials may enter these errors.
#[derive(Debug, Error, PartialEq, Eq)]
pub enum OidcDirectoryError {
  #[error("OIDC group directory is not configured")]
  Unconfigured,
  #[error("OIDC group directory configuration is invalid")]
  InvalidConfiguration,
  #[error("OIDC group directory read access denied (HTTP {0})")]
  AccessDenied(u16),
  #[error("OIDC group directory returned HTTP {0}")]
  HttpStatus(u16),
  #[error("OIDC group directory transport failed ({0})")]
  Transport(&'static str),
  #[error("OIDC group directory deadline exceeded")]
  Timeout,
  #[error("OIDC group directory retrieval limit exceeded")]
  LimitExceeded,
  #[error("OIDC group directory returned an invalid or incomplete response")]
  InvalidResponse,
  #[error("OIDC group directory redirect rejected")]
  RedirectRejected,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OidcDirectoryEntryState {
  Available,
  Ambiguous,
  Unavailable,
}

/// The ID identifies a catalog choice only. Persist claim_value in mappings,
/// never the ID, and only offer Available entries for catalog selection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcDirectoryEntry {
  pub id: String,
  pub display_name: String,
  pub path: Option<String>,
  pub claim_value: Option<String>,
  pub state: OidcDirectoryEntryState,
}

/// All pages visible to the configured read account, not proof of unrestricted
/// provider permissions. No claims, user memberships or credentials are retained.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcGroupDirectoryCatalog {
  pub entries: Vec<OidcDirectoryEntry>,
}

/// Minimal provider-owned inputs; adapters discard all other response fields.
/// claim_value is the explicitly chosen name/path before login normalization.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OidcDirectoryGroup {
  pub id: String,
  pub display_name: String,
  pub path: Option<String>,
  pub claim_value: String,
}

#[async_trait]
pub trait OidcGroupDirectoryPort: Send + Sync {
  /// Retrieve the entire visible catalog or fail; a failed page/limit must never
  /// return a successful partial catalog. This does not participate in login.
  /// The API caller must authorize the global administrator before invoking it.
  async fn retrieve(
    &self,
    connection: &OAuthGroupDirectoryConfig,
  ) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError>;
}

/// One normalization/collision projection shared by the concrete providers.
/// Conflicting duplicate IDs indicate an inconsistent read, not a new choice.
pub fn project_directory(groups: Vec<OidcDirectoryGroup>) -> Result<OidcGroupDirectoryCatalog, OidcDirectoryError> {
  if groups.len() > MAX_DIRECTORY_GROUPS {
    return Err(OidcDirectoryError::LimitExceeded);
  }
  let mut unique = HashMap::new();
  for group in groups {
    if group.id.trim().is_empty() {
      return Err(OidcDirectoryError::InvalidResponse);
    }
    if let Some(previous) = unique.insert(group.id.clone(), group.clone()) {
      if previous != group {
        return Err(OidcDirectoryError::InvalidResponse);
      }
    }
  }
  let mut entries = unique
    .into_values()
    .map(|group| {
      let claim_value = normalize_group_name(&group.claim_value);
      let state = if claim_value.is_some() {
        OidcDirectoryEntryState::Available
      } else {
        OidcDirectoryEntryState::Unavailable
      };
      OidcDirectoryEntry {
        id: group.id,
        display_name: group.display_name,
        path: group.path,
        claim_value,
        state,
      }
    })
    .collect::<Vec<_>>();
  let mut counts = HashMap::new();
  for entry in &entries {
    if let Some(value) = &entry.claim_value {
      *counts.entry(value.as_str()).or_insert(0usize) += 1;
    }
  }
  let ambiguous = entries
    .iter()
    .map(|entry| {
      entry
        .claim_value
        .as_ref()
        .is_some_and(|value| counts[value.as_str()] > 1)
    })
    .collect::<Vec<_>>();
  for (entry, ambiguous) in entries.iter_mut().zip(ambiguous) {
    if ambiguous {
      entry.state = OidcDirectoryEntryState::Ambiguous;
    }
  }
  entries.sort_by(|left, right| {
    left
      .display_name
      .cmp(&right.display_name)
      .then_with(|| left.id.cmp(&right.id))
  });
  Ok(OidcGroupDirectoryCatalog { entries })
}

#[cfg(test)]
mod tests {
  use super::*;

  fn group(id: &str, value: &str) -> OidcDirectoryGroup {
    OidcDirectoryGroup {
      id: id.into(),
      display_name: value.into(),
      path: None,
      claim_value: value.into(),
    }
  }

  #[test]
  fn projection_deduplicates_ids_and_blocks_only_normalized_claim_collisions() {
    let catalog = project_directory(vec![
      group("a", "/Engineering//Core/"),
      group("a", "/Engineering//Core/"),
      group("b", "Engineering/Core"),
      group("c", "engineering/core"),
      group("d", "/"),
      group("e", &"x".repeat(513)),
    ])
    .unwrap();
    assert_eq!(catalog.entries.len(), 5);
    for id in ["a", "b"] {
      let entry = catalog.entries.iter().find(|entry| entry.id == id).unwrap();
      assert_eq!(entry.state, OidcDirectoryEntryState::Ambiguous);
      assert_eq!(entry.claim_value.as_deref(), Some("Engineering/Core"));
    }
    assert_eq!(
      catalog.entries.iter().find(|entry| entry.id == "c").unwrap().state,
      OidcDirectoryEntryState::Available
    );
    for id in ["d", "e"] {
      let entry = catalog.entries.iter().find(|entry| entry.id == id).unwrap();
      assert_eq!(entry.state, OidcDirectoryEntryState::Unavailable);
      assert!(entry.claim_value.is_none());
    }
    // The login's 512-group claim limit must not truncate a directory catalog.
    let catalog = project_directory(
      (0..513)
        .map(|index| group(&index.to_string(), &format!("Group {index}")))
        .collect(),
    )
    .unwrap();
    assert_eq!(catalog.entries.len(), 513);
  }
}
