//! Prompt template registry with per-user rollout bucketing.
//!
//! [`PromptTemplateRegistry`] stores named sets of versioned prompt templates
//! and deterministically assigns a version to each user via a percentage-based
//! rollout bucket derived from the user's UUID.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};
use thiserror::Error;
use tracing::{debug, instrument};
use uuid::Uuid;

/// A single versioned variant of a prompt template.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PromptTemplateVersion {
  /// Semver-style version string (e.g. `"v1"`, `"v2"`).
  pub version: String,
  /// The raw prompt template text.
  pub template: String,
  /// Percentage of users who should receive this version (0–100).
  pub rollout_percent: u8,
  /// Whether this version is active.  Disabled versions are never served.
  pub enabled: bool,
}

/// A named collection of versioned prompt templates with a designated default.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PromptTemplateSet {
  /// Unique name identifying this template set (e.g. `"chat-with-ai"`).
  pub name: String,
  /// Version string to fall back to if rollout percentages do not sum to 100%.
  pub default_version: String,
  /// All available versions, in any order.
  pub versions: Vec<PromptTemplateVersion>,
}

/// Errors returned by [`PromptTemplateRegistry::resolve_for_user`].
#[derive(Debug, Error)]
pub enum PromptTemplateError {
  /// No template set with the given name is registered.
  #[error("template set not found: {0}")]
  NotFound(String),
  /// The template set exists but has no enabled version.
  #[error("no enabled template version available for set: {0}")]
  NoEnabledVersion(String),
}

/// Registry of prompt template sets.
///
/// Versions are selected per-user using a deterministic rollout bucket:
/// the lower 7 bits of the user's UUID are reduced modulo 100 to produce
/// a bucket in [0, 100).  Enabled versions are sorted by version string and
/// assigned contiguous bucket ranges according to their `rollout_percent`.
#[derive(Debug, Clone, Default)]
pub struct PromptTemplateRegistry {
  /// Template sets keyed by name.
  sets: HashMap<String, PromptTemplateSet>,
}

impl PromptTemplateRegistry {
  /// Register (or replace) a [`PromptTemplateSet`].
  pub fn register(&mut self, set: PromptTemplateSet) {
    self.sets.insert(set.name.clone(), set);
  }

  /// Resolve the prompt template version for a given user.
  ///
  /// The user's UUID determines a deterministic bucket (0–99).  Enabled
  /// versions are iterated in sorted order; the first version whose
  /// cumulative rollout percentage exceeds the bucket is returned.  If no
  /// version covers the bucket (sum < 100%), the configured default version
  /// is tried, then the first enabled version.
  #[instrument(skip(self))]
  pub fn resolve_for_user(
    &self,
    template_name: &str,
    user_id: Uuid,
  ) -> Result<PromptTemplateVersion, PromptTemplateError> {
    let set = self
      .sets
      .get(template_name)
      .ok_or_else(|| PromptTemplateError::NotFound(template_name.to_string()))?;

    let mut enabled = set
      .versions
      .iter()
      .filter(|version| version.enabled)
      .cloned()
      .collect::<Vec<_>>();
    if enabled.is_empty() {
      return Err(PromptTemplateError::NoEnabledVersion(template_name.to_string()));
    }

    enabled.sort_by_key(|version| version.version.clone());
    let bucket = (u128::from_le_bytes(user_id.as_u128().to_le_bytes()) % 100) as u8;
    let mut cumulative = 0u8;
    for version in &enabled {
      cumulative = cumulative.saturating_add(version.rollout_percent.min(100));
      if bucket < cumulative {
        debug!(template = %template_name, version = %version.version, bucket, "resolved template by rollout bucket");
        return Ok(version.clone());
      }
    }

    // Fallback to configured default version if rollout percentages do not cover 100%.
    if let Some(default) = enabled
      .iter()
      .find(|version| version.version == set.default_version)
      .cloned()
    {
      return Ok(default);
    }

    Ok(enabled[0].clone())
  }
}

#[cfg(test)]
mod tests {
  use super::*;

  fn registry() -> PromptTemplateRegistry {
    let mut registry = PromptTemplateRegistry::default();
    registry.register(PromptTemplateSet {
      name: "chat-with-ai".to_string(),
      default_version: "v1".to_string(),
      versions: vec![
        PromptTemplateVersion {
          version: "v1".to_string(),
          template: "old".to_string(),
          rollout_percent: 80,
          enabled: true,
        },
        PromptTemplateVersion {
          version: "v2".to_string(),
          template: "new".to_string(),
          rollout_percent: 20,
          enabled: true,
        },
      ],
    });
    registry
  }

  #[test]
  fn resolves_deterministically_for_same_user() {
    let registry = registry();
    let user_id = Uuid::new_v4();
    let first = registry.resolve_for_user("chat-with-ai", user_id).expect("resolve 1");
    let second = registry.resolve_for_user("chat-with-ai", user_id).expect("resolve 2");
    assert_eq!(first.version, second.version);
  }

  #[test]
  fn errors_when_template_set_is_missing() {
    let registry = PromptTemplateRegistry::default();
    let result = registry.resolve_for_user("missing", Uuid::new_v4());
    assert!(matches!(result, Err(PromptTemplateError::NotFound(_))));
  }
}
