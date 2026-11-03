// SPDX-License-Identifier: AGPL-3.0-or-later
//! Exhaustive persistence dependency manifest for workspace content operations.
//!
//! Every PostgreSQL relation owned directly or transitively by a workspace,
//! document, Database, or blob must occur exactly once below. The consuming
//! schema contract test derives the live ownership graph from foreign keys and
//! ownership columns, then compares it bidirectionally with this manifest.
//! Adding a relation therefore fails closed until its transfer behavior is
//! explicitly classified.

use std::collections::BTreeMap;

use serde::Serialize;

/// Current dependency-manifest schema version.
pub const WORKSPACE_CONTENT_DEPENDENCY_MANIFEST_VERSION: u32 = 1;

/// Required treatment of one persistence relation during an operation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum WorkspaceContentDependencyClass {
  CanonicalTransfer,
  WorkspaceReconcile,
  BlobMaterialize,
  DerivedRebuild,
  SourceOwned,
  PublicationPolicy,
}

impl WorkspaceContentDependencyClass {
  pub const fn as_str(self) -> &'static str {
    match self {
      Self::CanonicalTransfer => "canonical_transfer",
      Self::WorkspaceReconcile => "workspace_reconcile",
      Self::BlobMaterialize => "blob_materialize",
      Self::DerivedRebuild => "derived_rebuild",
      Self::SourceOwned => "source_owned",
      Self::PublicationPolicy => "publication_policy",
    }
  }

  pub const fn rationale(self) -> &'static str {
    match self {
      Self::CanonicalTransfer => "preserve on move and materialize a mapped canonical copy on copy",
      Self::WorkspaceReconcile => "reuse or create deterministic workspace-local definitions and mappings",
      Self::BlobMaterialize => "reuse content-addressed bytes or publish a verified staged copy",
      Self::DerivedRebuild => "never copy; invalidate and rebuild after canonical publication",
      Self::SourceOwned => "retain with the source or owning subsystem; never transfer implicitly",
      Self::PublicationPolicy => "apply the explicit public-sharing policy before publication",
    }
  }
}

/// One immutable relation entry in the versioned manifest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceContentDependency {
  pub relation: &'static str,
  pub class: WorkspaceContentDependencyClass,
}

const CANONICAL_TRANSFER: &[&str] = &[
  "comment_attachments",
  "comment_edit_history",
  "comment_thread_read_state",
  "comments",
  "doc_audience_assignment",
  "doc_histories",
  "doc_snapshots",
  "doc_updates",
  "doc_user_permissions",
  "docs",
  "document_integration_state",
  "document_presentation_state",
  "document_template_state",
  "document_version",
  "document_version_artifact",
  "document_version_label_counter",
  "document_version_relation",
  "document_versioning_settings",
];

const WORKSPACE_RECONCILE: &[&str] = &[
  "database_field_roles",
  "database_profiles",
  // Native Row metadata retains its scoped origin identity; this classification
  // does not authorize copying or remapping source identities.
  "database_row_source_links",
  "database_unique_id_sequences",
  "database_view_roles",
  "workspace_database_cell_values",
  "workspace_database_fields",
  "workspace_database_formula_dependencies",
  "workspace_database_relation_edges",
  "workspace_database_row_templates",
  "workspace_database_rows",
  "workspace_database_views",
  "workspace_databases",
  "workspace_document_audience_default",
  "workspace_tag_document_assignments",
  "workspace_tag_legacy_ids",
  "workspace_tags",
];

const BLOB_MATERIALIZE: &[&str] = &["blobs"];

const DERIVED_REBUILD: &[&str] = &[
  "ai_workspace_doc_embeddings",
  "ai_workspace_file_embeddings",
  "copilot_embeddings",
  "database_document_references",
  "database_row_tag_references",
  "document_graph_index_state",
  "document_graph_occurrences",
  "search_content",
  "workspace_analytics_minute",
  "workspace_database_formula_values",
  "workspace_database_page_inventory_revision",
  "workspace_database_rollup_values",
  "workspace_database_row_search",
  "workspace_document_metadata_epoch",
  "workspace_document_metadata_index_revision",
  "workspace_member_last_access",
  "workspace_storage_stats",
  "workspace_storage_stats_daily",
];

const SOURCE_OWNED: &[&str] = &[
  "admin_audit_log",
  "ai_workspace_files",
  "ai_workspace_ignored_docs",
  "app_server_branding",
  "brand_assets",
  "branding_assets",
  "branding_profiles",
  "calendar_event_instances",
  "calendar_event_participants",
  "calendar_event_source_links",
  "calendar_event_tags",
  "calendar_events",
  // Delivery identities and recipient receipts stay with their calendar owner;
  // copying them would carry prior delivery state into an unrelated workspace.
  "calendar_mail_state",
  "calendar_pending_writes",
  "calendar_reminder_dispatch_log",
  "calendar_reminder_mail_receipts",
  "calendar_reminders",
  "calendar_reminder_definitions",
  "copilot_context_items",
  "copilot_contexts",
  "copilot_jobs",
  // Completed transcript content is durable source data, not an index projection.
  "copilot_transcripts",
  "copilot_message_revisions",
  "copilot_messages",
  "copilot_sessions",
  "copilot_workspaces",
  "database_activity_events",
  "database_import_jobs",
  "database_row_reminders",
  // Actor/workspace request admission must never become copied/transferred payload.
  "database_task_capture_receipts",
  "database_view_user_states",
  "document_brand_profiles",
  // Pending notification intent belongs to its source scope, never a copy or transfer.
  "document_change_batches",
  "document_change_batch_actors",
  "document_edit_capture_state",
  "document_history_capture_request",
  "document_initial_sync_audit",
  "document_version_policy",
  "document_versioning_workspace_settings",
  "document_workspace_settings",
  "git_sync_baselines",
  "git_sync_bindings",
  "git_sync_blob_promotions",
  "git_sync_bootstrap_attempts",
  "git_sync_conflicts",
  "git_sync_credentials",
  "git_sync_file_baselines",
  "git_sync_file_bindings",
  "git_sync_file_conflicts",
  "git_sync_history_capture_receipts",
  "git_sync_partial_items",
  "git_sync_partial_sessions",
  "git_sync_path_owners",
  "git_sync_profiles",
  "git_sync_runs",
  // A detached scope fence stays with its source even if its target disappears.
  "git_sync_scope_exclusions",
  "git_sync_version_links",
  "git_sync_webhook_deliveries",
  "git_token_rotation",
  "multipart_blob_parts",
  "multipart_uploads",
  "notifications",
  "organization_unit_workspace",
  // Workspace-local registration decisions survive Move at their source key.
  "page_registration_evidence",
  "pdf_export_jobs",
  "pdf_export_render_audit",
  "pdf_export_settings",
  "pdf_fonts",
  "pdf_icc_profiles",
  "pdf_template_files",
  "pdf_workspace_template_assignments",
  // Engine state is owned transitively by the native source automation run.
  // Persisted table names remain part of that deployed runtime contract.
  "sayiir_workflow_claims",
  "sayiir_workflow_events",
  "sayiir_workflow_signals",
  "sayiir_workflow_snapshot_history",
  "sayiir_workflow_snapshots",
  "sayiir_workflow_tasks",
  // Timing consent and slot receipts stay with their native source; copies or
  // workspace transfers must never inherit automatic work or delivery identity.
  "scheduling_schedules",
  "scheduling_occurrences",
  "scheduling_pause_intervals",
  "task_recurrence_series",
  "task_recurrence_members",
  "search_reindex_runs",
  "template_import_jobs",
  "template_reconcile_jobs",
  "template_registry_audit_events",
  "template_revisions",
  "theme_profiles",
  "workspace_automation_actions",
  "workspace_automation_runs",
  "workspace_automations",
  "workspace_calendar_settings",
  "workspace_calendars",
  "workspace_content_operation_compensations",
  // Historical views belong to the workspace where they occurred, not the document's later owner.
  "workspace_doc_view_daily",
  "workspace_content_copy_publications",
  "workspace_content_extract_publications",
  "workspace_content_extract_targets",
  "workspace_content_link_publications",
  "workspace_content_move_revision_manifests",
  "workspace_content_move_publications",
  "workspace_content_operation_link_intents",
  "workspace_content_operation_mappings",
  "workspace_content_operation_recipient_outbox",
  "workspace_content_operation_redirects",
  "workspace_content_operation_requests",
  "workspace_content_operation_staging",
  "workspace_content_operations",
  "workspace_database_csv_mapping_templates",
  "workspace_import_compensations",
  "workspace_import_id_mappings",
  "workspace_import_parts",
  "workspace_imports",
  "workspace_invite_links",
  "workspace_memberships",
  // Actor-owned creation identities survive result deletion and never transfer.
  "workspace_starter_applications",
  // Retirement identities prevent resurrection only inside their owning
  // workspace. Copying them could suppress an unrelated Tag identity in the
  // target workspace, so content operations never transfer them implicitly.
  "workspace_tag_retired_ids",
  "workspace_template_instances",
  "workspace_template_policies",
  "workspaces",
];

const PUBLICATION_POLICY: &[&str] = &["public_asset_manifest", "public_render_artifacts"];

const MANIFEST_GROUPS: &[(WorkspaceContentDependencyClass, &[&str])] = &[
  (WorkspaceContentDependencyClass::CanonicalTransfer, CANONICAL_TRANSFER),
  (WorkspaceContentDependencyClass::WorkspaceReconcile, WORKSPACE_RECONCILE),
  (WorkspaceContentDependencyClass::BlobMaterialize, BLOB_MATERIALIZE),
  (WorkspaceContentDependencyClass::DerivedRebuild, DERIVED_REBUILD),
  (WorkspaceContentDependencyClass::SourceOwned, SOURCE_OWNED),
  (WorkspaceContentDependencyClass::PublicationPolicy, PUBLICATION_POLICY),
];

/// Return the complete relation map, rejecting duplicate declarations.
///
/// The `Result` is intentional: duplicate classification is a manifest defect,
/// not a last-entry-wins condition.
pub fn workspace_content_dependency_manifest()
-> Result<BTreeMap<&'static str, WorkspaceContentDependency>, &'static str> {
  let mut manifest = BTreeMap::new();
  for (class, relations) in MANIFEST_GROUPS {
    for &relation in *relations {
      if manifest
        .insert(
          relation,
          WorkspaceContentDependency {
            relation,
            class: *class,
          },
        )
        .is_some()
      {
        return Err("duplicate workspace content dependency relation");
      }
    }
  }
  Ok(manifest)
}

/// Resolve one relation without fallback classification.
pub fn workspace_content_dependency(relation: &str) -> Option<WorkspaceContentDependency> {
  workspace_content_dependency_manifest()
    .expect("static dependency manifest must be disjoint")
    .get(relation)
    .copied()
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn dependency_manifest_is_versioned_disjoint_and_fail_closed() {
    assert_eq!(WORKSPACE_CONTENT_DEPENDENCY_MANIFEST_VERSION, 1);
    let manifest = workspace_content_dependency_manifest().expect("disjoint manifest");
    for class in [
      WorkspaceContentDependencyClass::CanonicalTransfer,
      WorkspaceContentDependencyClass::WorkspaceReconcile,
      WorkspaceContentDependencyClass::BlobMaterialize,
      WorkspaceContentDependencyClass::DerivedRebuild,
      WorkspaceContentDependencyClass::SourceOwned,
      WorkspaceContentDependencyClass::PublicationPolicy,
    ] {
      assert!(
        manifest.values().any(|entry| entry.class == class),
        "{} must own at least one relation",
        class.as_str()
      );
      assert!(!class.rationale().is_empty());
    }
    assert!(
      workspace_content_dependency("future_unclassified_relation").is_none(),
      "unknown relations must never receive a default class"
    );
    for (relation, expected) in [
      ("docs", WorkspaceContentDependencyClass::CanonicalTransfer),
      (
        "workspace_database_rows",
        WorkspaceContentDependencyClass::WorkspaceReconcile,
      ),
      ("blobs", WorkspaceContentDependencyClass::BlobMaterialize),
      ("search_content", WorkspaceContentDependencyClass::DerivedRebuild),
      (
        "workspace_document_metadata_index_revision",
        WorkspaceContentDependencyClass::DerivedRebuild,
      ),
      (
        "workspace_database_page_inventory_revision",
        WorkspaceContentDependencyClass::DerivedRebuild,
      ),
      ("notifications", WorkspaceContentDependencyClass::SourceOwned),
      (
        "workspace_starter_applications",
        WorkspaceContentDependencyClass::SourceOwned,
      ),
      ("calendar_mail_state", WorkspaceContentDependencyClass::SourceOwned),
      (
        "calendar_reminder_mail_receipts",
        WorkspaceContentDependencyClass::SourceOwned,
      ),
      ("document_change_batches", WorkspaceContentDependencyClass::SourceOwned),
      (
        "document_change_batch_actors",
        WorkspaceContentDependencyClass::SourceOwned,
      ),
      (
        "document_edit_capture_state",
        WorkspaceContentDependencyClass::SourceOwned,
      ),
      (
        "document_history_capture_request",
        WorkspaceContentDependencyClass::SourceOwned,
      ),
      (
        "public_render_artifacts",
        WorkspaceContentDependencyClass::PublicationPolicy,
      ),
    ] {
      assert_eq!(
        workspace_content_dependency(relation).map(|entry| entry.class),
        Some(expected),
        "{relation} must retain its product-semantic treatment"
      );
    }
  }
}
