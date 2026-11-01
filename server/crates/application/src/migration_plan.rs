//! Static migration plan describing how legacy AFFiNE database tables map to
//! the Myoxus target schema.
//!
//! [`INITIAL_LEGACY_TABLE_MAPPINGS`] is a compile-time constant slice that
//! documents the intended disposition of each upstream table.  It serves as
//! a reference for migration tooling and code review; it is not executed at
//! runtime.

use serde::{Deserialize, Serialize};

/// The intended handling for a legacy database table during migration.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub enum LegacyTableDisposition {
  /// Port the table to the core Myoxus schema with minimal transformation.
  PortToCoreSchema,
  /// Transform the data structure before porting (e.g. layout changes).
  TransformAndPort,
  /// Archive the data without porting it to the new schema.
  ArchiveOnly,
  /// Deliberately ignored — table belongs to the removed billing subsystem.
  IgnoreAsLegacyBilling,
}

/// A mapping from a legacy AFFiNE table to its Myoxus equivalent.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct LegacyTableMapping {
  /// Name of the table in the legacy AFFiNE database.
  pub legacy_table: &'static str,
  /// Name of the corresponding table in the Myoxus schema, if any.
  pub target_table: Option<&'static str>,
  /// How this table should be handled during migration.
  pub disposition: LegacyTableDisposition,
  /// Human-readable migration note for reviewers.
  pub note: &'static str,
}

/// Compile-time migration plan: the full set of legacy tables and their
/// intended dispositions in the initial Myoxus migration.
pub const INITIAL_LEGACY_TABLE_MAPPINGS: &[LegacyTableMapping] = &[
  LegacyTableMapping {
    legacy_table: "user",
    target_table: Some("users"),
    disposition: LegacyTableDisposition::PortToCoreSchema,
    note: "Core identity table, keep user ids stable where possible.",
  },
  LegacyTableMapping {
    legacy_table: "workspace",
    target_table: Some("workspaces"),
    disposition: LegacyTableDisposition::PortToCoreSchema,
    note: "Core collaboration root.",
  },
  LegacyTableMapping {
    legacy_table: "doc",
    target_table: Some("docs"),
    disposition: LegacyTableDisposition::TransformAndPort,
    note: "Root-doc semantics preserved, internal layout can be optimized.",
  },
  LegacyTableMapping {
    legacy_table: "blob",
    target_table: Some("blobs"),
    disposition: LegacyTableDisposition::PortToCoreSchema,
    note: "Blob metadata kept, storage backend bindings may change.",
  },
  LegacyTableMapping {
    legacy_table: "subscription",
    target_table: None,
    disposition: LegacyTableDisposition::IgnoreAsLegacyBilling,
    note: "Billing not part of target server.",
  },
  LegacyTableMapping {
    legacy_table: "license",
    target_table: None,
    disposition: LegacyTableDisposition::IgnoreAsLegacyBilling,
    note: "License and paid features are removed from target scope.",
  },
];
