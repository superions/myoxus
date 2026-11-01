// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared Git-Sync policy resolution.
//!
//! GraphQL mutations, the polling scheduler and the runner must evaluate the
//! same effective policy. Keeping this logic outside resolver code prevents a
//! profile that was valid at creation time from bypassing later admin changes.

use std::collections::HashSet;

use crate::config::GitSyncPolicyConfig;
use myoxus_application::git_sync::{HttpsCertificatePolicy, SshHostKeyPolicy};

/// Effective Git-Sync policy after YAML/ENV defaults and DB overrides.
#[derive(Debug, Clone)]
pub struct EffectiveGitSyncPolicy {
  pub enabled: bool,
  pub allowed_directions: HashSet<String>,
  pub allowed_auth_methods: HashSet<String>,
  pub allowed_hosts: HashSet<String>,
  pub default_branch: String,
  pub auto_sync_allowed: bool,
  pub webhook_allowed: bool,
  pub ssh_host_key_policy: SshHostKeyPolicy,
  pub https_certificate_policy: HttpsCertificatePolicy,
  pub max_mirror_storage_mb: u64,
}

impl EffectiveGitSyncPolicy {
  pub fn lifecycle_policy(&self) -> myoxus_application::git_sync::GitSyncLifecyclePolicy {
    use myoxus_domain::git_sync::{AuthMethod, SyncDirection};

    let allowed_directions = [
      ("bidirectional", SyncDirection::Bidirectional),
      ("myoxus_to_git", SyncDirection::MyoxusToGit),
      ("git_to_myoxus", SyncDirection::GitToMyoxus),
    ]
    .into_iter()
    .filter_map(|(key, value)| self.allowed_directions.contains(key).then_some(value))
    .collect();
    let allowed_auth_methods = [
      ("https_token", AuthMethod::HttpsToken),
      ("https_password", AuthMethod::HttpsPassword),
      ("ssh_key", AuthMethod::SshKey),
    ]
    .into_iter()
    .filter_map(|(key, value)| self.allowed_auth_methods.contains(key).then_some(value))
    .collect();

    myoxus_application::git_sync::GitSyncLifecyclePolicy {
      enabled: self.enabled,
      allowed_directions,
      allowed_auth_methods,
      allowed_hosts: self.allowed_hosts.clone(),
      auto_sync_allowed: self.auto_sync_allowed,
      webhook_allowed: self.webhook_allowed,
    }
  }

  pub fn is_auth_method_allowed(&self, auth_method: myoxus_domain::git_sync::AuthMethod) -> bool {
    self.allowed_auth_methods.contains(auth_method_key(auth_method))
  }

  pub fn is_sync_direction_allowed(&self, direction: myoxus_domain::git_sync::SyncDirection) -> bool {
    self.allowed_directions.contains(sync_direction_key(direction))
  }

  pub fn is_repo_host_allowed(&self, repo_url: &str) -> bool {
    self.allowed_hosts.is_empty()
      || extract_git_repo_host(repo_url)
        .as_ref()
        .is_some_and(|host| self.allowed_hosts.contains(host))
  }

  pub fn profile_violation(&self, profile: &myoxus_domain::git_sync::GitSyncProfile) -> Option<String> {
    if !self.enabled {
      return Some("Git Sync is disabled by administrator policy".to_string());
    }
    if !profile.enabled {
      return Some("Git Sync profile is disabled".to_string());
    }
    if !self.is_auth_method_allowed(profile.auth_method) {
      return Some("authentication method is not allowed by administrator policy".to_string());
    }
    if !self.is_sync_direction_allowed(profile.sync_direction) {
      return Some("sync direction is not allowed by administrator policy".to_string());
    }
    if !self.is_repo_host_allowed(&profile.repo_url) {
      return Some("repository host is not allowed by administrator policy".to_string());
    }
    None
  }
}

pub fn auth_method_key(auth_method: myoxus_domain::git_sync::AuthMethod) -> &'static str {
  match auth_method {
    myoxus_domain::git_sync::AuthMethod::HttpsToken => "https_token",
    myoxus_domain::git_sync::AuthMethod::HttpsPassword => "https_password",
    myoxus_domain::git_sync::AuthMethod::SshKey => "ssh_key",
  }
}

pub fn sync_direction_key(direction: myoxus_domain::git_sync::SyncDirection) -> &'static str {
  match direction {
    myoxus_domain::git_sync::SyncDirection::Bidirectional => "bidirectional",
    myoxus_domain::git_sync::SyncDirection::MyoxusToGit => "myoxus_to_git",
    myoxus_domain::git_sync::SyncDirection::GitToMyoxus => "git_to_myoxus",
  }
}

pub fn resolve_effective_git_sync_policy(
  effective: &crate::config_reload::EffectiveConfig,
) -> Result<EffectiveGitSyncPolicy, String> {
  resolve_git_sync_policy(&effective.base.git_sync, &effective.overrides.overrides)
}

/// Resolve Git-Sync policy from the typed startup baseline and the universal
/// live override snapshot. Worker paths use this form because they do not own
/// an [`ApiState`](crate::state::ApiState).
pub fn resolve_git_sync_policy(
  static_policy: &GitSyncPolicyConfig,
  overrides: &std::collections::HashMap<String, serde_json::Value>,
) -> Result<EffectiveGitSyncPolicy, String> {
  let normalize_list = |input: &[String]| {
    input
      .iter()
      .map(|entry| entry.trim().to_ascii_lowercase())
      .filter(|entry| !entry.is_empty())
      .collect::<Vec<_>>()
  };
  let list = |path: &str, fallback: &[String]| {
    overrides
      .get(path)
      .and_then(serde_json::Value::as_array)
      .map(|values| {
        values
          .iter()
          .filter_map(serde_json::Value::as_str)
          .map(ToOwned::to_owned)
          .collect::<Vec<_>>()
      })
      .map(|values| normalize_list(&values))
      .unwrap_or_else(|| normalize_list(fallback))
  };
  let string = |path: &str| overrides.get(path).and_then(serde_json::Value::as_str);
  let bool_value = |path: &str| overrides.get(path).and_then(serde_json::Value::as_bool);
  let ssh_host_key_policy = string("git_sync.ssh_host_key_policy")
    .and_then(SshHostKeyPolicy::parse)
    .unwrap_or(static_policy.ssh_host_key_policy);
  let https_certificate_policy = string("git_sync.https_certificate_policy")
    .and_then(HttpsCertificatePolicy::parse)
    .unwrap_or(static_policy.https_certificate_policy);
  Ok(EffectiveGitSyncPolicy {
    enabled: bool_value("git_sync.enabled").unwrap_or(static_policy.enabled),
    allowed_directions: list("git_sync.allowed_directions", &static_policy.allowed_directions)
      .into_iter()
      .collect(),
    allowed_auth_methods: list("git_sync.allowed_auth_methods", &static_policy.allowed_auth_methods)
      .into_iter()
      .collect(),
    allowed_hosts: list("git_sync.allowed_hosts", &static_policy.allowed_hosts)
      .into_iter()
      .collect(),
    default_branch: string("git_sync.default_branch")
      .filter(|value| !value.trim().is_empty())
      .map(ToOwned::to_owned)
      .unwrap_or_else(|| static_policy.default_branch.clone()),
    auto_sync_allowed: bool_value("git_sync.auto_sync_allowed").unwrap_or(static_policy.auto_sync_allowed),
    webhook_allowed: bool_value("git_sync.webhook_allowed").unwrap_or(static_policy.webhook_allowed),
    ssh_host_key_policy,
    https_certificate_policy,
    max_mirror_storage_mb: overrides
      .get("git_sync.max_mirror_storage_mb")
      .and_then(|value| value.as_u64())
      .unwrap_or(static_policy.max_mirror_storage_mb),
  })
}

pub fn extract_git_repo_host(repo_url: &str) -> Option<String> {
  fn host_from_authority(authority: &str) -> Option<String> {
    let without_user = authority.rsplit('@').next().unwrap_or(authority);
    let host = without_user.split(':').next().unwrap_or(without_user);
    let host = host.trim().trim_matches('[').trim_matches(']');
    if host.is_empty() {
      None
    } else {
      Some(host.to_ascii_lowercase())
    }
  }

  let repo_url = repo_url.trim();
  if let Some(rest) = repo_url
    .strip_prefix("https://")
    .or_else(|| repo_url.strip_prefix("http://"))
    .or_else(|| repo_url.strip_prefix("ssh://"))
  {
    let authority = rest.split('/').next().unwrap_or_default();
    return host_from_authority(authority);
  }

  if let Some((authority, _)) = repo_url.split_once(':')
    && authority.contains('@')
    && !authority.contains('/')
  {
    return host_from_authority(authority);
  }

  None
}
