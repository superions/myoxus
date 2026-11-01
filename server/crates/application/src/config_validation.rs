// SPDX-License-Identifier: AGPL-3.0-or-later
//! Narrow port from configuration persistence to the API-owned startup schema.

use std::collections::HashMap;

/// Complete logical state prepared under the configuration transaction lock.
#[derive(Clone, Debug)]
pub struct PreparedConfigCandidate {
  /// Exact registered overrides that would remain in PostgreSQL.
  pub database_overrides: HashMap<String, serde_json::Value>,
  /// Exact prospective runtime-overlay YAML. `None` means that mirroring is
  /// disabled or its storage is unreadable; the DB candidate remains validatable
  /// independently and the mirror outcome is reported after commit.
  pub runtime_overlay_yaml: Option<String>,
}

/// Side-effect-free access to the authoritative typed startup decoder.
///
/// Infrastructure owns candidate preparation but cannot depend on the API
/// startup schema. Every composition root must provide this port; there is no
/// optional or permissive implementation.
pub trait StartupConfigValidator: Send + Sync {
  fn validate(&self, candidate: &PreparedConfigCandidate) -> Result<(), String>;
}
