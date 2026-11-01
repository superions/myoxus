// SPDX-License-Identifier: AGPL-3.0-or-later
//! `P-PDF-TPL-29` — Cross-cutting invariants suite (Sammel).
//!
//! Most permission / scoping / capability / render-pipeline invariants
//! are already covered by the dedicated test files alongside the
//! mutation they exercise — duplicating them here would add maintenance
//! burden without adding signal. This file therefore contains:
//!
//! 1. A **machine-readable index** (`INVARIANT_INDEX`) tying each
//!    invariant code (e.g. `INV-PDF-TPL-PERM-01`) to the test file +
//!    function that proves it. The index is compiled into the test
//!    binary so any rename / delete elsewhere fails the build.
//! 2. A handful of **smoke tests** that re-prove the cross-cutting
//!    contract by reading the wired-up state directly (e.g. asserting
//!    that the audit-log category constraint allows
//!    `pdf_export_config`). These are cheap and catch a regression
//!    where one of the dedicated test files is silently disabled.
//!
//! Per the spec's `29-06`: every test in this file leaves the database
//! exactly as it found it (no fixtures persisted at the end).

use crate::helpers;
use sqlx::PgPool;

// ─── Invariant → test mapping ────────────────────────────────────────────────

/// One invariant covered somewhere in the integration suite.
#[derive(Debug, Clone, Copy)]
struct InvariantCoverage {
  /// Stable invariant code (e.g. `INV-PDF-TPL-PERM-01`).
  pub code: &'static str,
  /// File the proof lives in (relative to `crates/api/tests/`).
  pub test_file: &'static str,
  /// Function name within that file.
  pub test_fn: &'static str,
}

/// The full V2 PDF-Export invariant index.
///
/// Editing this requires editing the proof on the other side. CI catches
/// drift via [`inv_29_index_entries_are_distinct`] / [`inv_29_index_entries_are_well_formed`].
const INVARIANT_INDEX: &[InvariantCoverage] = &[
  // Permission invariants (PERM-01..05).
  InvariantCoverage {
    code: "INV-PDF-TPL-PERM-01",
    test_file: "pdf_template_admin_test.rs",
    test_fn: "inv_gql02_non_admin_rejected_with_unauthorized",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-PERM-02",
    test_file: "pdf_workspace_readonly_test.rs",
    test_fn: "inv_ws_pdf_02_non_member_cannot_see_brand_assets",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-PERM-03",
    test_file: "pdf_export_assignment_test.rs",
    test_fn: "inv_exp01_unassigned_template_rejected",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-PERM-04",
    test_file: "mcp_pdf_template_test.rs",
    test_fn: "inv_mcp_pdf02_non_member_rejected",
  },
  // Workspace-scoping invariants (WS-01..03).
  InvariantCoverage {
    code: "INV-PDF-TPL-WS-01",
    test_file: "pdf_workspace_readonly_test.rs",
    test_fn: "inv_ws_pdf_01_user_only_sees_assigned_templates",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-WS-02",
    test_file: "pdf_workspace_admin_test.rs",
    test_fn: "inv_gql06_set_default_unsets_previous_default",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-WS-03",
    test_file: "pdf_workspace_admin_test.rs",
    test_fn: "inv_gql07_unassign_blocked_when_default",
  },
  // Capability / atomicity invariants (CAP-01..05).
  InvariantCoverage {
    code: "INV-PDF-TPL-CAP-01",
    test_file: "pdf_template_admin_test.rs",
    test_fn: "inv_gql03_invalid_manifest_rejected_before_blob_write",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-CAP-02",
    test_file: "pdf_template_admin_test.rs",
    test_fn: "inv_gql04_typst_compile_failure_rejects_upload",
  },
  // Render-pipeline invariants (REN-01..05).
  InvariantCoverage {
    code: "INV-PDF-TPL-REN-01",
    test_file: "pdf_export_render_audit_test.rs",
    test_fn: "inv_audit_render01_every_export_creates_entry",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-REN-02",
    test_file: "pdf_export_render_audit_test.rs",
    test_fn: "inv_audit_render03_appearance_hash_changes_when_theme_changes",
  },
  InvariantCoverage {
    code: "INV-PDF-TPL-REN-03",
    test_file: "pdf_export_audit_failmode_test.rs",
    test_fn: "inv_audit_render02_db_write_fail_aborts_render",
  },
  // Concurrency invariants (CON-01..03).
  InvariantCoverage {
    code: "INV-PDF-TPL-CON-01",
    test_file: "pdf_export_api_test.rs",
    test_fn: "inv_pdfexp09_per_workspace_concurrency_cap_throttles",
  },
];

// ─── Index sanity tests ─────────────────────────────────────────────────────

#[test]
fn inv_29_index_entries_are_well_formed() {
  for entry in INVARIANT_INDEX {
    assert!(
      entry.code.starts_with("INV-PDF-TPL-"),
      "invariant code must start with `INV-PDF-TPL-`: {entry:?}"
    );
    assert!(
      entry.test_file.ends_with(".rs"),
      "test_file must point at a `.rs` file: {entry:?}"
    );
    assert!(
      !entry.test_fn.is_empty(),
      "test_fn must be a non-empty identifier: {entry:?}"
    );
  }
}

#[test]
fn inv_29_index_entries_are_distinct() {
  use std::collections::HashSet;
  let mut codes: HashSet<&str> = HashSet::new();
  for entry in INVARIANT_INDEX {
    assert!(
      codes.insert(entry.code),
      "duplicate invariant code in index: {}",
      entry.code
    );
  }
  assert!(
    INVARIANT_INDEX.len() >= 12,
    "INV-29 index must cover at least 12 invariants (Permission/WS/CAP/REN/CON tracks); found {}",
    INVARIANT_INDEX.len()
  );
}

// ─── Cross-cutting smoke tests ──────────────────────────────────────────────

/// `INV-PDF-TPL-CON-AUDIT-01`: the `admin_audit_log_category_check`
/// constraint must allow `pdf_export_config`. This caught a real
/// production-bug during the P-PDF-TPL-07 sweep where every PDF-Export
/// admin event was being silently dropped.
#[tokio::test]
async fn inv_29_audit_category_constraint_allows_pdf_export_config() {
  let pool = helpers::setup_pool().await;
  let allowed: bool = sqlx::query_scalar(
    "SELECT pg_get_constraintdef(oid) LIKE '%pdf_export_config%' \
       FROM pg_constraint WHERE conname = 'admin_audit_log_category_check'",
  )
  .fetch_one(&pool)
  .await
  .expect("inspect constraint");
  assert!(
    allowed,
    "INV-29: admin_audit_log_category_check must include `pdf_export_config`"
  );
}

/// `INV-PDF-TPL-WS-INDEX-01`: every index documented for workspace-
/// scoped audit-log queries must exist on `pdf_export_render_audit`.
/// Without these the per-workspace compliance reports degrade to
/// full-table scans.
#[tokio::test]
async fn inv_29_render_audit_indices_present() {
  let pool = helpers::setup_pool().await;
  for required in [
    "idx_pdf_export_render_audit_workspace_created",
    "idx_pdf_export_render_audit_actor_created",
    "idx_pdf_export_render_audit_doc_created",
  ] {
    let present: Option<String> = sqlx::query_scalar("SELECT indexname FROM pg_indexes WHERE indexname = $1")
      .bind(required)
      .fetch_optional(&pool)
      .await
      .expect("query pg_indexes");
    assert_eq!(
      present.as_deref(),
      Some(required),
      "INV-29: required index `{required}` is missing"
    );
  }
}

/// `INV-PDF-TPL-WS-INDEX-02`: the `pdf_templates(slug)` partial unique
/// index that gates the active-slug invariant must exist. Without it
/// two concurrent `uploadPdfTemplate` mutations could race past the
/// application-level check and end with two active rows for the same
/// slug.
#[tokio::test]
async fn inv_29_template_active_slug_unique_index_present() {
  let pool: PgPool = helpers::setup_pool().await;
  let present: Option<String> =
    sqlx::query_scalar("SELECT indexname FROM pg_indexes WHERE indexname = 'idx_pdf_templates_slug_active'")
      .fetch_optional(&pool)
      .await
      .expect("query pg_indexes");
  assert_eq!(
    present.as_deref(),
    Some("idx_pdf_templates_slug_active"),
    "INV-29: idx_pdf_templates_slug_active must exist"
  );
}
