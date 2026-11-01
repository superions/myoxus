// SPDX-License-Identifier: AGPL-3.0-or-later
//! IR schema migration support.
//!
//! When `CURRENT_IR_VERSION` is incremented, add a new `IrMigration` impl and
//! register it in `MIGRATIONS`. The loader calls `migrate_to_current` which
//! chains all applicable migrations automatically.

use crate::error::IrBuildError;
use crate::ir::CURRENT_IR_VERSION;

/// A single IR version migration step.
pub trait IrMigration: Send + Sync {
  /// The IR version this migration reads.
  fn source_version(&self) -> u32;
  /// The IR version this migration produces.
  fn target_version(&self) -> u32;
  /// Transform the raw JSON value in-place from `source_version` to `target_version`.
  fn migrate(&self, value: &mut serde_json::Value) -> Result<(), String>;
}

/// Registry of all known migrations, ordered from oldest to newest.
static MIGRATIONS: &[&dyn IrMigration] = &[
  // Future: &Migration1To2,
];

/// Migrate a raw IR JSON value from its declared version up to `CURRENT_IR_VERSION`.
///
/// Returns `Err(IrBuildError::UnsupportedVersion)` if the value's version is
/// greater than `CURRENT_IR_VERSION` (forward incompatibility).
pub fn migrate_to_current(value: &mut serde_json::Value) -> Result<(), IrBuildError> {
  let found_version = value
    .get("version")
    .and_then(|v| v.as_u64())
    .map(|v| v as u32)
    .unwrap_or(1);

  if found_version > CURRENT_IR_VERSION {
    return Err(IrBuildError::UnsupportedVersion {
      found: found_version,
      min: 1,
      max: CURRENT_IR_VERSION,
    });
  }

  let mut current = found_version;
  for migration in MIGRATIONS {
    if migration.source_version() == current {
      migration
        .migrate(value)
        .map_err(|e| IrBuildError::YjsDecode(format!("migration {current}→{}: {e}", migration.target_version())))?;
      current = migration.target_version();
      // Update the version field in the value.
      if let Some(obj) = value.as_object_mut() {
        obj.insert("version".to_string(), serde_json::json!(current));
      }
    }
  }

  Ok(())
}
