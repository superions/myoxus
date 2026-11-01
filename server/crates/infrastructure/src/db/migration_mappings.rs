//! Accessor for the legacy → Myoxus table migration plan.
//!
//! Delegates to [`myoxus_application::migration_plan::INITIAL_LEGACY_TABLE_MAPPINGS`]
//! so that infrastructure tooling can reference the canonical plan without a
//! direct dependency on the application crate's constants.

use myoxus_application::migration_plan::INITIAL_LEGACY_TABLE_MAPPINGS;

/// Return the canonical set of legacy table mappings defined in the
/// application crate.
pub fn legacy_table_mappings() -> &'static [myoxus_application::migration_plan::LegacyTableMapping] {
  INITIAL_LEGACY_TABLE_MAPPINGS
}
