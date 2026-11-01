// SPDX-License-Identifier: AGPL-3.0-or-later
//! Shared MIME policy configuration projection.
//!
//! Upload entry points live in different outer crates (REST, GraphQL, MCP and
//! Git Sync), but they must all evaluate the same admin-managed policy. This
//! module projects the universal runtime override snapshot over startup
//! configuration supplied by the caller. It deliberately owns no SQL reader.

use myoxus_application::mime_policy::{MimePolicyConfig, MimeValidationMode};

/// Startup-config fallback values used when no live `app_configs` row exists.
pub struct MimePolicyFallback<'a> {
  pub allowlist: &'a [String],
  pub blocklist: &'a [String],
  pub validation_mode: &'a str,
}

/// Resolve MIME policy from the canonical live configuration snapshot.
///
/// Invalid or missing rows fail closed to the caller-provided startup defaults
/// rather than silently widening the policy beyond what the server booted with.
pub fn resolve_mime_policy_config(
  overrides: &std::collections::HashMap<String, serde_json::Value>,
  fallback: &MimePolicyFallback<'_>,
) -> MimePolicyConfig {
  let allowlist = overrides
    .get("git_sync.mime_allowlist_admin")
    .and_then(|val| {
      val.as_array().map(|arr| {
        arr
          .iter()
          .filter_map(|v| v.as_str().map(String::from))
          .collect::<Vec<_>>()
      })
    })
    .unwrap_or_else(|| fallback.allowlist.to_vec());

  let blocklist = overrides
    .get("git_sync.mime_blocklist_admin")
    .and_then(|val| {
      val.as_array().map(|arr| {
        arr
          .iter()
          .filter_map(|v| v.as_str().map(String::from))
          .collect::<Vec<_>>()
      })
    })
    .unwrap_or_else(|| fallback.blocklist.to_vec());

  let mode = overrides
    .get("git_sync.mime_validation_mode")
    .and_then(serde_json::Value::as_str)
    .and_then(MimeValidationMode::parse_mode)
    .unwrap_or_else(|| MimeValidationMode::parse_mode(fallback.validation_mode).unwrap_or(MimeValidationMode::Warn));

  MimePolicyConfig {
    allowlist,
    blocklist,
    mode,
  }
}
