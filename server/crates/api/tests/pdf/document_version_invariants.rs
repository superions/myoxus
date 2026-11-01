// SPDX-License-Identifier: AGPL-3.0-or-later
//! Traceability gate for the Document-Versioning invariant catalogue.
//!
//! The behavior itself is covered by the referenced repository, GraphQL and PDF
//! bridge tests. This file prevents the recurring failure mode where a TODO says
//! "INV-DOC-VER-01..10" but the architecture doc and the real guards drift apart.

const ARCH_DOC: &str = include_str!("../../../../../docs/dev/server/pdf-export-v2-architecture.md");
const SERVER_DONE: &str = include_str!("../../../../../todo/server-done.md");
const DOCVER_GQL_TESTS: &str = include_str!("document_version_graphql_test.rs");
const PDF_BRIDGE_TESTS: &str = include_str!("pdf_export_v2_mutation_test.rs");
const DOCVER_REPO_TESTS: &str = include_str!("../../../infrastructure/tests/document_version_repos.rs");

const INVARIANTS: [(&str, &[&str]); 10] = [
  (
    "INV-DOC-VER-01",
    &[
      "inv_docver01_create_persists_with_history_link",
      "inv_docver_gql04_mutations_create_pin_unpin_and_update_settings",
    ],
  ),
  (
    "INV-DOC-VER-02",
    &[
      "inv_docver02_unique_label_per_doc_enforced",
      "inv_docver_gql08_duplicate_label_does_not_capture_orphan_history",
    ],
  ),
  ("INV-DOC-VER-03", &["inv_docver03_cascade_delete_on_doc_removal"]),
  (
    "INV-DOC-VER-04",
    &[
      "inv_docver_gql06_restore_creates_new_history_not_in_place",
      "inv_audit_docver02_restore_logged_with_source_version",
    ],
  ),
  (
    "INV-DOC-VER-05",
    &[
      "inv_docver_gql05_delete_pinned_blocked",
      "inv_docver04_gc_keeps_pinned_and_doc_history_snapshots",
    ],
  ),
  (
    "INV-DOC-VER-06",
    &[
      "inv_docver_gql02_rejects_non_member_and_returns_settings_defaults_without_insert",
      "inv_docver_gql07_mutations_reject_non_member_before_side_effects",
      "inv_docver_gql13_diff_rejects_non_member",
      "inv_bridge03_latest_selector_rejects_foreign_workspace_doc",
    ],
  ),
  (
    "INV-DOC-VER-07",
    &[
      "inv_docver_gql02_rejects_non_member_and_returns_settings_defaults_without_insert",
      "inv_docver_gql04_mutations_create_pin_unpin_and_update_settings",
    ],
  ),
  (
    "INV-DOC-VER-08",
    &[
      "inv_bridge01_pdf_export_with_label_uses_history_snapshot",
      "inv_bridge02_auto_trigger_creates_version_before_render",
    ],
  ),
  (
    "INV-DOC-VER-09",
    &["inv_docver_gql10_daily_trigger_skips_unchanged_doc"],
  ),
  (
    "INV-DOC-VER-10",
    &["inv_docver04_gc_keeps_pinned_and_doc_history_snapshots"],
  ),
];

fn all_guard_sources() -> String {
  [
    DOCVER_GQL_TESTS,
    PDF_BRIDGE_TESTS,
    DOCVER_REPO_TESTS,
    ARCH_DOC,
    SERVER_DONE,
  ]
  .join("\n")
}

#[test]
fn inv_docver_matrix_01_architecture_defines_all_invariants() {
  for (invariant, _) in INVARIANTS {
    assert!(
      ARCH_DOC.contains(invariant),
      "{invariant} must be defined in the architecture invariant table"
    );
  }
}

#[test]
fn inv_docver_matrix_02_done_archive_points_at_traceability_gate() {
  assert!(
    SERVER_DONE.contains("P-DOC-VER-10-01"),
    "server done archive must keep the P-DOC-VER-10-01 closeout visible"
  );
  assert!(
    SERVER_DONE.contains("document_version_invariants.rs"),
    "P-DOC-VER-10-01 closeout must point reviewers to the traceability gate"
  );
}

#[test]
fn inv_docver_matrix_03_each_invariant_has_behavioral_guards() {
  let sources = all_guard_sources();
  for (invariant, guards) in INVARIANTS {
    assert!(!guards.is_empty(), "{invariant} must list at least one behavior guard");
    for guard in guards {
      assert!(
        sources.contains(guard),
        "{invariant} references missing behavior guard {guard}"
      );
    }
  }
}
