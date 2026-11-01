// SPDX-License-Identifier: AGPL-3.0-or-later
//! Workspace storage quota resolution and source classification.

/// Which level determined the effective workspace quota
/// for a workspace.
///
/// Used by admin tools to display a breakdown of how a quota was resolved.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum QuotaSource {
  /// Workspace-level override is in effect (`workspaces.storage_quota_bytes` is set and > 0).
  WorkspaceOverride,
  /// Global config default applies (no workspace override; config value > 0 in MB).
  ConfigDefault,
  /// No quota — workspace has unlimited storage (all levels are zero/unset).
  Unlimited,
}

impl QuotaSource {
  /// Determine which source is active given the raw DB values and config default.
  pub fn resolve(workspace_override_bytes: Option<i64>, config_default_mb: u64) -> Self {
    if workspace_override_bytes.map(|v| v > 0).unwrap_or(false) {
      return Self::WorkspaceOverride;
    }
    if config_default_mb > 0 {
      return Self::ConfigDefault;
    }
    Self::Unlimited
  }
}

/// Resolve the effective storage quota for a workspace.
///
/// `workspace_quota_bytes`: per-workspace override from DB (None = not set)
/// `config_default_mb`: global config default in MB (0 = unlimited)
///
/// Returns the effective quota in bytes, or 0 for unlimited.
pub fn effective_quota_bytes(workspace_quota_bytes: Option<i64>, config_default_mb: u64) -> u64 {
  // Level 1: workspace-level override
  if let Some(wq) = workspace_quota_bytes
    && wq > 0
  {
    return wq as u64;
  }

  // Level 2: config default (MB -> bytes)
  if config_default_mb > 0 {
    return config_default_mb * 1024 * 1024;
  }

  // Level 3: unlimited
  0
}

/// Check if a proposed write would exceed the effective quota.
///
/// `current_usage_bytes`: current total storage (snapshot + blob) for the workspace
/// `write_size_bytes`: size of the proposed write operation
/// `quota_bytes`: effective quota from `effective_quota_bytes()` (0 = unlimited)
///
/// Returns `Ok(())` if the write is allowed, `Err(message)` if it would exceed the quota.
pub fn check_quota(current_usage_bytes: u64, write_size_bytes: u64, quota_bytes: u64) -> Result<(), QuotaExceeded> {
  if quota_bytes == 0 {
    return Ok(()); // unlimited
  }

  let projected = current_usage_bytes.saturating_add(write_size_bytes);
  if projected > quota_bytes {
    return Err(QuotaExceeded {
      current_bytes: current_usage_bytes,
      write_bytes: write_size_bytes,
      quota_bytes,
      projected_bytes: projected,
    });
  }

  Ok(())
}

/// Error type for quota violations.
#[derive(Debug, Clone)]
pub struct QuotaExceeded {
  pub current_bytes: u64,
  pub write_bytes: u64,
  pub quota_bytes: u64,
  pub projected_bytes: u64,
}

impl std::fmt::Display for QuotaExceeded {
  fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
    let current_mb = self.current_bytes / (1024 * 1024);
    let quota_mb = self.quota_bytes / (1024 * 1024);
    write!(
      f,
      "workspace storage quota exceeded: {current_mb} MB used + {} bytes write > {quota_mb} MB limit",
      self.write_bytes
    )
  }
}

impl std::error::Error for QuotaExceeded {}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn workspace_override_takes_priority() {
    let quota = effective_quota_bytes(Some(500_000_000), 2048);
    assert_eq!(quota, 500_000_000); // workspace wins
  }

  #[test]
  fn config_default_when_no_overrides() {
    let quota = effective_quota_bytes(None, 512);
    assert_eq!(quota, 512 * 1024 * 1024); // 512 MB in bytes
  }

  #[test]
  fn unlimited_when_all_zero_or_none() {
    let quota = effective_quota_bytes(None, 0);
    assert_eq!(quota, 0); // unlimited
  }

  #[test]
  fn zero_workspace_override_falls_through() {
    let quota = effective_quota_bytes(Some(0), 1024);
    assert_eq!(quota, 1024 * 1024 * 1024);
  }

  #[test]
  fn check_quota_allows_under_limit() {
    let result = check_quota(400_000_000, 50_000_000, 500_000_000);
    assert!(result.is_ok());
  }

  #[test]
  fn check_quota_rejects_over_limit() {
    let result = check_quota(400_000_000, 200_000_000, 500_000_000);
    assert!(result.is_err());
    let err = result.unwrap_err();
    assert_eq!(err.current_bytes, 400_000_000);
    assert_eq!(err.write_bytes, 200_000_000);
    assert_eq!(err.quota_bytes, 500_000_000);
  }

  #[test]
  fn check_quota_unlimited_always_allows() {
    let result = check_quota(999_999_999_999, 999_999_999_999, 0);
    assert!(result.is_ok()); // 0 = unlimited
  }

  #[test]
  fn check_quota_exact_limit_allowed() {
    let result = check_quota(400_000_000, 100_000_000, 500_000_000);
    assert!(result.is_ok()); // exactly at limit, not over
  }

  #[test]
  fn check_quota_one_byte_over_rejected() {
    let result = check_quota(500_000_000, 1, 500_000_000);
    assert!(result.is_err()); // 1 byte over
  }
}
